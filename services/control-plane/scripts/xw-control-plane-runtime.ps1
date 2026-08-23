param(
    [string]$RuntimeRoot = "C:\Users\Public\xw-runtime",
    [string]$ContractPath = "",
    [ValidateSet("QUALIFICATION_ONLY", "FINAL")]
    [string]$Mode = "FINAL",
    [switch]$ValidateOnly,
    [switch]$VerifyReleaseOnly
)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"
# NOTE: keep this file ASCII-only (PS 5.1 misreads UTF-8-no-BOM scripts).

function Fail-Closed([string]$Code) {
    throw $Code
}

function Test-ExactProperties($Value, [string[]]$Expected) {
    if ($null -eq $Value) { return $false }
    $actual = @($Value.PSObject.Properties.Name | Sort-Object)
    $wanted = @($Expected | Sort-Object)
    if ($actual.Count -ne $wanted.Count) { return $false }
    for ($index = 0; $index -lt $wanted.Count; $index += 1) {
        if ([string]$actual[$index] -cne [string]$wanted[$index]) { return $false }
    }
    return $true
}

function Test-Hash([string]$Value) {
    return $Value -match '^[0-9a-f]{64}$' -and $Value -notmatch '^0{64}$'
}

function Get-Sha256([string]$Path) {
    $stream = [IO.File]::OpenRead($Path)
    try {
        $sha = [Security.Cryptography.SHA256]::Create()
        try { return ([BitConverter]::ToString($sha.ComputeHash($stream))).Replace("-", "").ToLowerInvariant() }
        finally { $sha.Dispose() }
    } finally { $stream.Dispose() }
}

function Resolve-AbsolutePath([string]$Value, [string]$Code) {
    if ([string]::IsNullOrWhiteSpace($Value) -or -not [IO.Path]::IsPathRooted($Value)) { Fail-Closed $Code }
    return [IO.Path]::GetFullPath($Value)
}

function Assert-PlainDirectory([string]$Path, [string]$Code) {
    if (-not (Test-Path -LiteralPath $Path -PathType Container)) { Fail-Closed $Code }
    $item = Get-Item -LiteralPath $Path -Force
    if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { Fail-Closed $Code }
}

function Assert-PlainFile([string]$Path, [string]$Code) {
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { Fail-Closed $Code }
    $item = Get-Item -LiteralPath $Path -Force
    if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { Fail-Closed $Code }
}

function Test-Within([string]$Root, [string]$Candidate) {
    $rootFull = [IO.Path]::GetFullPath($Root).TrimEnd('\') + '\'
    $candidateFull = [IO.Path]::GetFullPath($Candidate)
    return $candidateFull.StartsWith($rootFull, [StringComparison]::OrdinalIgnoreCase)
}

function Test-SamePath([string]$Left, [string]$Right) {
    if ([string]::IsNullOrWhiteSpace($Left) -or [string]::IsNullOrWhiteSpace($Right) `
        -or -not [IO.Path]::IsPathRooted($Left) -or -not [IO.Path]::IsPathRooted($Right)) { return $false }
    try { return [IO.Path]::GetFullPath($Left).Equals([IO.Path]::GetFullPath($Right), [StringComparison]::OrdinalIgnoreCase) }
    catch { return $false }
}

function Assert-ImmutableSourceRelease(
    [string]$NodeExecutable,
    [string]$RuntimeRoot,
    [string]$CurrentPath,
    [string]$ReleaseRoot
) {
    $releasesRoot = Join-Path $RuntimeRoot "releases"
    Assert-PlainDirectory $releasesRoot "M6_C1_IMMUTABLE_RELEASE_INVALID"
    Assert-PlainDirectory $ReleaseRoot "M6_C1_IMMUTABLE_RELEASE_INVALID"
    $pendingDirectories = New-Object System.Collections.Generic.Stack[string]
    $pendingDirectories.Push($ReleaseRoot)
    while ($pendingDirectories.Count -gt 0) {
        $directory = $pendingDirectories.Pop()
        foreach ($item in @(Get-ChildItem -LiteralPath $directory -Force -ErrorAction Stop)) {
            if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
                Fail-Closed "M6_C1_IMMUTABLE_RELEASE_INVALID"
            }
            if ($item.PSIsContainer) {
                $pendingDirectories.Push($item.FullName)
            } elseif (-not ($item -is [IO.FileInfo])) {
                Fail-Closed "M6_C1_IMMUTABLE_RELEASE_INVALID"
            }
        }
    }
    # This verifier is deliberately embedded in the external launcher. It uses
    # Node built-ins only and never imports code from the release being checked.
    $verifier = @'
const { createHash } = require("node:crypto");
const { lstatSync, readFileSync, readdirSync, realpathSync, statSync } = require("node:fs");
const { basename, dirname, isAbsolute, join, relative, resolve, sep } = require("node:path");

const MANIFEST = "release-manifest.v1.json";
const TOP_LEVEL_KEYS = [
  "schemaId", "releaseId", "sourceRepo", "sourceCommit", "sourceTreeSha",
  "runtimeProfile", "nodeVersion", "npmVersion", "services", "files",
  "runtimeCutoverAllowed",
];
const FILE_KEYS = ["path", "gitMode", "gitBlobOid", "sha256"];
const SERVICE_KEYS = ["path", "treeSha256"];
const REGULAR_MODES = new Set(["100644", "100755"]);
const SHA256 = /^(?!0{64}$)[0-9a-f]{64}$/u;
const SHA1 = /^(?!0{40}$)[0-9a-f]{40}$/u;
const quit = () => process.exit(1);

const exact = (value, keys) => value && typeof value === "object" && !Array.isArray(value)
  && JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...keys].sort());
const compareUtf8 = (left, right) => Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
const hash = (algorithm, bytes) => createHash(algorithm).update(bytes).digest("hex");
const pathKey = (value) => process.platform === "win32" ? resolve(value).toLowerCase() : resolve(value);
const samePath = (left, right) => pathKey(left) === pathKey(right);
const within = (root, candidate) => {
  const value = relative(resolve(root), resolve(candidate));
  return value !== "" && value !== ".." && !value.startsWith(`..${sep}`) && !isAbsolute(value);
};
const gitObjectId = (type, bytes) => {
  const body = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  return hash("sha1", Buffer.concat([Buffer.from(`${type} ${body.length}\0`, "utf8"), body]));
};
const gitBlobOid = (bytes) => gitObjectId("blob", bytes);
const validPath = (value) => {
  if (typeof value !== "string" || value === "" || value.length > 1024 || value.includes("\0")
    || value.includes("\\") || value.startsWith("/") || /^[A-Za-z]:/u.test(value)
    || /[\x00-\x1f\x7f]/u.test(value)) return false;
  const parts = value.split("/");
  if (parts.some((part) => part === "" || part === "." || part === "..")) return false;
  if (value.toLowerCase() === MANIFEST || parts.some((part) => [".git", "node_modules"].includes(part.toLowerCase()))) return false;
  const reserved = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/iu;
  if (parts.some((part) => /[<>:"|?*]/u.test(part) || /[. ]$/u.test(part) || reserved.test(part))) return false;
  return true;
};

function gitTreeOid(entries) {
  const root = { children: new Map() };
  for (const entry of entries) {
    if (!validPath(entry.path) || !REGULAR_MODES.has(entry.gitMode) || !SHA1.test(entry.gitBlobOid || "")) throw new Error("entry");
    const parts = entry.path.split("/");
    let node = root;
    for (const part of parts.slice(0, -1)) {
      const present = node.children.get(part);
      if (present?.kind === "blob") throw new Error("conflict");
      if (!present) node.children.set(part, { kind: "tree", children: new Map() });
      node = node.children.get(part);
    }
    const name = parts.at(-1);
    if (node.children.has(name)) throw new Error("duplicate");
    node.children.set(name, { kind: "blob", gitMode: entry.gitMode, objectId: entry.gitBlobOid });
  }
  const seal = (node) => {
    const children = [...node.children.entries()].map(([name, child]) => child.kind === "tree"
      ? { name, kind: "tree", gitMode: "40000", objectId: seal(child) }
      : { name, ...child })
      .sort((left, right) => compareUtf8(
        `${left.name}${left.kind === "tree" ? "/" : ""}`,
        `${right.name}${right.kind === "tree" ? "/" : ""}`,
      ));
    const bytes = Buffer.concat(children.flatMap((entry) => [
      Buffer.from(`${entry.gitMode} ${entry.name}\0`, "utf8"),
      Buffer.from(entry.objectId, "hex"),
    ]));
    return gitObjectId("tree", bytes);
  };
  return seal(root);
}

function walkRelease(root) {
  const canonicalRoot = realpathSync(root);
  const entries = [];
  const walk = (directory) => {
    const children = readdirSync(directory, { withFileTypes: true })
      .sort((left, right) => compareUtf8(left.name, right.name));
    for (const child of children) {
      const target = join(directory, child.name);
      const entryPath = relative(root, target).split(sep).join("/");
      const item = lstatSync(target);
      if (item.isSymbolicLink() || (!item.isDirectory() && !item.isFile())) throw new Error("type");
      if (item.isFile() && item.nlink !== 1) throw new Error("hardlink");
      const expectedRealPath = join(canonicalRoot, ...entryPath.split("/"));
      if (!samePath(realpathSync(target), expectedRealPath)) throw new Error("reparse");
      if (item.isDirectory()) {
        entries.push({ path: entryPath, type: "directory" });
        walk(target);
      } else {
        entries.push({ path: entryPath, type: "file", stat: item });
      }
    }
  };
  walk(root);
  return entries;
}

function serviceTreeSha(files, prefix) {
  const digest = createHash("sha256");
  for (const entry of files) {
    if (entry.path.startsWith(`${prefix}/`)) digest.update(`${entry.path}:${entry.sha256}\n`, "utf8");
  }
  return digest.digest("hex");
}

try {
  const runtimeRoot = resolve(process.argv[2]);
  const currentPath = resolve(process.argv[3]);
  const releaseRoot = resolve(process.argv[4]);
  const releasesRoot = join(runtimeRoot, "releases");
  const runtimeStat = lstatSync(runtimeRoot);
  const releasesStat = lstatSync(releasesRoot);
  const releaseStat = lstatSync(releaseRoot);
  const currentStat = lstatSync(currentPath);
  const currentTargetStat = statSync(currentPath, { bigint: true });
  const releaseTargetStat = statSync(releaseRoot, { bigint: true });
  const currentMatches = currentTargetStat.dev === releaseTargetStat.dev
    && currentTargetStat.ino === releaseTargetStat.ino;
  if (!runtimeStat.isDirectory() || runtimeStat.isSymbolicLink()
    || !releasesStat.isDirectory() || releasesStat.isSymbolicLink()
    || !releaseStat.isDirectory() || releaseStat.isSymbolicLink()
    || !currentStat.isSymbolicLink() || !statSync(currentPath).isDirectory()
    || !samePath(dirname(releaseRoot), releasesRoot) || !within(releasesRoot, releaseRoot)
    || !currentMatches) quit("boundary");

  const materialized = walkRelease(releaseRoot);
  const actualByPath = new Map(materialized.map((entry) => [entry.path, entry]));
  if (actualByPath.size !== materialized.length) quit("actual-duplicate");
  const manifestEntry = actualByPath.get(MANIFEST);
  if (!manifestEntry || manifestEntry.type !== "file") quit("manifest-entry");
  const manifestPath = join(releaseRoot, MANIFEST);
  const manifestBytes = readFileSync(manifestPath);
  const manifest = JSON.parse(manifestBytes.toString("utf8"));
  if (manifestBytes.toString("utf8") !== `${JSON.stringify(manifest, null, 2)}\n`
    || !exact(manifest, TOP_LEVEL_KEYS)
    || manifest.schemaId !== "xw.runtime.release-manifest.v1"
    || !/^[a-z0-9][a-z0-9._-]{2,127}$/u.test(manifest.releaseId || "")
    || basename(releaseRoot) !== manifest.releaseId
    || manifest.sourceRepo !== "gifted-professor/xw-platform"
    || !SHA1.test(manifest.sourceCommit || "") || !SHA1.test(manifest.sourceTreeSha || "")
    || manifest.runtimeProfile !== "legacy_compat"
    || typeof manifest.nodeVersion !== "string" || manifest.nodeVersion === ""
    || !(manifest.npmVersion === null || (typeof manifest.npmVersion === "string" && manifest.npmVersion !== ""))
    || manifest.runtimeCutoverAllowed !== false
    || !exact(manifest.services, ["orchestrator", "controlPlane"])
    || !Array.isArray(manifest.files)) quit("manifest-schema");

  const expectedServices = { orchestrator: "services/orchestrator", controlPlane: "services/control-plane" };
  for (const [name, prefix] of Object.entries(expectedServices)) {
    const service = manifest.services[name];
    if (!exact(service, SERVICE_KEYS) || service.path !== prefix || !SHA256.test(service.treeSha256 || "")) quit("service-schema");
  }

  const declared = [];
  const declaredByPath = new Map();
  const caseFoldedPaths = new Set();
  for (const entry of manifest.files) {
    if (!exact(entry, FILE_KEYS) || !validPath(entry.path) || !REGULAR_MODES.has(entry.gitMode)
      || !SHA1.test(entry.gitBlobOid || "") || !SHA256.test(entry.sha256 || "")
      || declaredByPath.has(entry.path)) quit("file-schema");
    const caseKey = process.platform === "win32" ? entry.path.toLowerCase() : entry.path;
    if (caseFoldedPaths.has(caseKey)) quit("file-case-collision");
    caseFoldedPaths.add(caseKey);
    declaredByPath.set(entry.path, entry);
    declared.push(entry);
  }
  const orderedPaths = [...declared].sort((left, right) => compareUtf8(left.path, right.path)).map((entry) => entry.path);
  if (orderedPaths.some((entryPath, index) => entryPath !== declared[index].path)) quit("file-order");

  const expectedDirectories = new Set();
  for (const entry of declared) {
    const parts = entry.path.split("/");
    for (let index = 1; index < parts.length; index += 1) expectedDirectories.add(parts.slice(0, index).join("/"));
  }
  const expectedFiles = new Set([MANIFEST, ...declared.map((entry) => entry.path)]);
  for (const entry of materialized) {
    if (entry.type === "directory") {
      if (!expectedDirectories.has(entry.path)) quit("extra-directory");
    } else if (!expectedFiles.has(entry.path)) quit("extra-file");
  }
  if (expectedFiles.size !== declared.length + 1) quit("manifest-declared");
  for (const entryPath of expectedDirectories) {
    if (actualByPath.get(entryPath)?.type !== "directory") quit("missing-directory");
  }
  for (const entryPath of expectedFiles) {
    if (actualByPath.get(entryPath)?.type !== "file") quit("missing-file");
  }

  const actualTreeEntries = [];
  for (const entry of declared) {
    const actual = actualByPath.get(entry.path);
    const bytes = readFileSync(join(releaseRoot, ...entry.path.split("/")));
    const actualSha = hash("sha256", bytes);
    const actualBlob = gitBlobOid(bytes);
    const actualMode = process.platform === "win32"
      ? entry.gitMode
      : ((actual.stat.mode & 0o111) !== 0 ? "100755" : "100644");
    if (actualSha !== entry.sha256 || actualBlob !== entry.gitBlobOid || actualMode !== entry.gitMode) quit("file-identity");
    actualTreeEntries.push({ path: entry.path, gitMode: actualMode, gitBlobOid: actualBlob });
  }
  if (gitTreeOid(declared) !== manifest.sourceTreeSha || gitTreeOid(actualTreeEntries) !== manifest.sourceTreeSha) quit("source-tree");
  for (const [name, prefix] of Object.entries(expectedServices)) {
    if (manifest.services[name].treeSha256 !== serviceTreeSha(declared, prefix)) quit("service-tree");
  }
} catch {
  process.exit(1);
}
'@
    $verifier | & $NodeExecutable - $RuntimeRoot $CurrentPath $ReleaseRoot | Out-Null
    if ($LASTEXITCODE -ne 0) { Fail-Closed "M6_C1_IMMUTABLE_RELEASE_INVALID" }
}

function Assert-GateFCatalog(
    [string]$NodeExecutable,
    [string]$Path,
    [string]$ExpectedHash,
    [string]$ExpectedReleaseId,
    [string]$ExpectedSourceCommit,
    [string]$ExpectedReleaseRoot,
    [string]$ExpectedReleaseManifestPath
) {
    $verifier = @'
const { createHash } = require("node:crypto");
const { lstatSync, readFileSync, realpathSync, statSync } = require("node:fs");
const { isAbsolute, relative, resolve, sep } = require("node:path");
const exact = (value, keys) => value && typeof value === "object" && !Array.isArray(value)
  && JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...keys].sort());
const canonicalize = (value) => Array.isArray(value) ? value.map(canonicalize)
  : value && typeof value === "object"
    ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])])) : value;
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const hashPattern = /^(?!0{64}$)[0-9a-f]{64}$/u;
const plainBytes = (path) => {
  if (!isAbsolute(path)) throw new Error("path");
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("plain-file");
  return readFileSync(realpathSync(path));
};
const entryKey = (path) => {
  const stat = statSync(path, { bigint: true });
  return `${stat.dev}:${stat.ino}`;
};
const nested = (root, target) => {
  const value = relative(resolve(root), resolve(target));
  return value === "" || (value !== ".." && !value.startsWith(`..${sep}`) && !isAbsolute(value));
};
const lockKinds = ["runtimeProfile","hardRedlinePolicy","groundingRuntime","dshSource","dshProfile","liveToolSpec","modelProfile","liveProvider","grantActionPolicy","brokerProtocol","typedTransport","scenarioManifest","environmentQualification"];
const runtimeKinds = ["environmentAttestation","independentOracle","operator","resetObligations"];
const modes = new Set(["RAW_SHA256","TREE_SHA256","LIVE_MODEL_PROFILE","M6_COHORT_MANIFEST","TARGET_ENV_ATTESTATION","ENVIRONMENT_QUALIFICATION"]);
const purposes = ["M6_4_SHADOW","M6_4_HOT_CLOSE","M6_4_ACTION_SMOKE","M6_4_RELIABILITY","M6_4_SMOOTH"];
try {
  const expectedReleaseRoot = entryKey(process.argv[6]);
  const expectedReleaseManifestPath = entryKey(process.argv[7]);
  if (!nested(realpathSync(process.argv[6]), realpathSync(process.argv[7]))) process.exit(1);
  const catalog = JSON.parse(plainBytes(process.argv[2]).toString("utf8"));
  const expected = process.argv[3];
  if (!exact(catalog, ["catalogHash","entries","release","schemaId"])
    || catalog.schemaId !== "xw.m6-gate-f-artifact-catalog.v1" || catalog.catalogHash !== expected
    || !exact(catalog.release, ["releaseId","sourceCommit"])
    || catalog.release.releaseId !== process.argv[4] || catalog.release.sourceCommit !== process.argv[5]
    || !Array.isArray(catalog.entries) || catalog.entries.length !== purposes.length) process.exit(1);
  const { catalogHash, ...catalogBody } = catalog;
  if (hash(`xw.m6-gate-f-artifact-catalog.v1:${JSON.stringify(canonicalize(catalogBody))}`) !== expected) process.exit(1);
  const seen = { inventoryHash: new Set(), inventoryPath: new Set(), manifestHash: new Set() };
  let releaseRoot = null;
  let releaseManifestPath = null;
  for (let index = 0; index < purposes.length; index += 1) {
    const entry = catalog.entries[index];
    if (!exact(entry, ["inventoryHash","inventoryPath","inventorySha256","purpose","scenarioManifestHash"])
      || entry.purpose !== purposes[index] || !isAbsolute(entry.inventoryPath)
      || !hashPattern.test(entry.inventoryHash) || !hashPattern.test(entry.inventorySha256)
      || !hashPattern.test(entry.scenarioManifestHash)) process.exit(1);
    const inventoryBytes = plainBytes(entry.inventoryPath);
    if (hash(inventoryBytes) !== entry.inventorySha256) process.exit(1);
    const inventory = JSON.parse(inventoryBytes.toString("utf8"));
    if (!exact(inventory, ["inventoryHash","lockArtifacts","release","runtimeArtifacts","schemaId"])
      || inventory.schemaId !== "xw.m6-gate-f-artifact-inventory.v1" || inventory.inventoryHash !== entry.inventoryHash
      || !exact(inventory.release, ["manifestPath","root"]) || !isAbsolute(inventory.release.root)
      || !isAbsolute(inventory.release.manifestPath) || !nested(inventory.release.root, inventory.release.manifestPath)
      || !exact(inventory.lockArtifacts, lockKinds) || !exact(inventory.runtimeArtifacts, runtimeKinds)) process.exit(1);
    const { inventoryHash, ...inventoryBody } = inventory;
    if (hash(`xw.m6-gate-f-artifact-inventory.v1:${JSON.stringify(canonicalize(inventoryBody))}`) !== entry.inventoryHash) process.exit(1);
    for (const descriptor of [...Object.values(inventory.lockArtifacts), ...Object.values(inventory.runtimeArtifacts)]) {
      if (!exact(descriptor, ["mode","path"]) || !modes.has(descriptor.mode) || !isAbsolute(descriptor.path)) process.exit(1);
    }
    if (inventory.lockArtifacts.modelProfile.mode !== "LIVE_MODEL_PROFILE"
      || inventory.lockArtifacts.scenarioManifest.mode !== "M6_COHORT_MANIFEST"
      || inventory.lockArtifacts.environmentQualification.mode !== "ENVIRONMENT_QUALIFICATION"
      || inventory.runtimeArtifacts.environmentAttestation.mode !== "TARGET_ENV_ATTESTATION"
      || ["independentOracle","operator","resetObligations"].some((key) => inventory.runtimeArtifacts[key].mode !== "RAW_SHA256")) process.exit(1);
    const scenario = JSON.parse(plainBytes(inventory.lockArtifacts.scenarioManifest.path).toString("utf8"));
    const release = JSON.parse(plainBytes(inventory.release.manifestPath).toString("utf8"));
    const { manifestHash, ...scenarioBody } = scenario;
    if (scenario.purpose !== entry.purpose || manifestHash !== entry.scenarioManifestHash
      || hash(`xw.m6-4-cohort-manifest.v1:${JSON.stringify(canonicalize(scenarioBody))}`) !== entry.scenarioManifestHash
      || release.releaseId !== catalog.release.releaseId || release.sourceCommit !== catalog.release.sourceCommit) process.exit(1);
    const inventoryPath = entryKey(entry.inventoryPath);
    const currentReleaseRoot = entryKey(inventory.release.root);
    const currentReleaseManifestPath = entryKey(inventory.release.manifestPath);
    if (seen.inventoryHash.has(entry.inventoryHash) || seen.inventoryPath.has(inventoryPath)
      || seen.manifestHash.has(entry.scenarioManifestHash)) process.exit(1);
    seen.inventoryHash.add(entry.inventoryHash); seen.inventoryPath.add(inventoryPath); seen.manifestHash.add(entry.scenarioManifestHash);
    releaseRoot ??= currentReleaseRoot; releaseManifestPath ??= currentReleaseManifestPath;
    if (releaseRoot !== currentReleaseRoot || releaseManifestPath !== currentReleaseManifestPath
      || currentReleaseRoot !== expectedReleaseRoot
      || currentReleaseManifestPath !== expectedReleaseManifestPath) process.exit(1);
  }
} catch { process.exit(1); }
'@
    $verifier | & $NodeExecutable - $Path $ExpectedHash $ExpectedReleaseId $ExpectedSourceCommit $ExpectedReleaseRoot $ExpectedReleaseManifestPath | Out-Null
    if ($LASTEXITCODE -ne 0) { Fail-Closed "M6_C1_GATE_F_CATALOG_INVALID" }
}

function Assert-RequiredEnvironment([string]$Name, [int]$MinimumLength, [switch]$Hash) {
    $value = [Environment]::GetEnvironmentVariable($Name, "Process")
    $valid = -not [string]::IsNullOrWhiteSpace($value) -and $value.Length -ge $MinimumLength -and $value.Length -le 4096 -and $value -notmatch '[\x00\r\n]'
    if ($Hash) { $valid = $valid -and (Test-Hash $value) }
    if (-not $valid) { Fail-Closed ("M6_C1_REQUIRED_ENVIRONMENT_UNAVAILABLE:" + $Name) }
}

function Clear-ProcessEnvironment([string[]]$Names) {
    foreach ($name in $Names) { [Environment]::SetEnvironmentVariable($name, $null, "Process") }
}

function Set-M64PrivateAclOnEntry(
    [System.IO.FileSystemInfo]$Item,
    [Security.Principal.SecurityIdentifier]$CurrentSid,
    [string[]]$AllowedSidValues
) {
    $isDirectory = $Item -is [System.IO.DirectoryInfo]
    if (($Item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0 `
        -or (-not $isDirectory -and -not ($Item -is [System.IO.FileInfo]))) {
        Fail-Closed "M6_C1_AUDIT_ROOT_ACL_INVALID"
    }
    if ($isDirectory) {
        $security = New-Object Security.AccessControl.DirectorySecurity
        $inheritance = [Security.AccessControl.InheritanceFlags]::ContainerInherit `
            -bor [Security.AccessControl.InheritanceFlags]::ObjectInherit
    } else {
        $security = New-Object Security.AccessControl.FileSecurity
        $inheritance = [Security.AccessControl.InheritanceFlags]::None
    }
    $rights = [Security.AccessControl.FileSystemRights]::FullControl
    $propagation = [Security.AccessControl.PropagationFlags]::None
    $allow = [Security.AccessControl.AccessControlType]::Allow
    $security.SetOwner($CurrentSid)
    $security.SetAccessRuleProtection($true, $false)
    foreach ($sidValue in $AllowedSidValues) {
        $sid = New-Object Security.Principal.SecurityIdentifier($sidValue)
        $rule = New-Object Security.AccessControl.FileSystemAccessRule(
            $sid, $rights, $inheritance, $propagation, $allow
        )
        $security.AddAccessRule($rule)
    }
    if ($isDirectory) {
        [IO.Directory]::SetAccessControl($Item.FullName, [Security.AccessControl.DirectorySecurity]$security)
        $persisted = [IO.Directory]::GetAccessControl(
            $Item.FullName,
            [Security.AccessControl.AccessControlSections]::Owner -bor [Security.AccessControl.AccessControlSections]::Access
        )
    } else {
        [IO.File]::SetAccessControl($Item.FullName, [Security.AccessControl.FileSecurity]$security)
        $persisted = [IO.File]::GetAccessControl(
            $Item.FullName,
            [Security.AccessControl.AccessControlSections]::Owner -bor [Security.AccessControl.AccessControlSections]::Access
        )
    }
    $persistedOwner = [string]$persisted.GetOwner([Security.Principal.SecurityIdentifier]).Value
    $persistedRules = @($persisted.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier]))
    if (-not $persisted.AreAccessRulesProtected -or $persistedOwner -cne $CurrentSid.Value `
        -or $persistedRules.Count -ne $AllowedSidValues.Count) {
        Fail-Closed "M6_C1_AUDIT_ROOT_ACL_INVALID"
    }
    foreach ($sidValue in $AllowedSidValues) {
        $matching = @($persistedRules | Where-Object {
            [string]$_.IdentityReference.Value -ceq $sidValue `
                -and $_.AccessControlType -eq $allow `
                -and $_.FileSystemRights -eq $rights `
                -and $_.InheritanceFlags -eq $inheritance `
                -and $_.PropagationFlags -eq $propagation `
                -and -not $_.IsInherited
        })
        if ($matching.Count -ne 1) { Fail-Closed "M6_C1_AUDIT_ROOT_ACL_INVALID" }
    }
}

function Initialize-M64PrivateAuditRoot([string]$RuntimeRoot) {
    try {
        $auditRoot = [IO.Path]::GetFullPath((Join-Path $RuntimeRoot "m6-audit"))
        if (-not (Test-Within $RuntimeRoot $auditRoot)) { Fail-Closed "M6_C1_AUDIT_ROOT_ACL_INVALID" }
        $existing = Get-Item -LiteralPath $auditRoot -Force -ErrorAction SilentlyContinue
        if ($null -eq $existing) {
            [IO.Directory]::CreateDirectory($auditRoot) | Out-Null
            $existing = Get-Item -LiteralPath $auditRoot -Force -ErrorAction Stop
        }
        if (-not $existing.PSIsContainer `
            -or ($existing.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
            Fail-Closed "M6_C1_AUDIT_ROOT_ACL_INVALID"
        }
        $currentSid = [Security.Principal.WindowsIdentity]::GetCurrent().User
        if ($null -eq $currentSid) { Fail-Closed "M6_C1_AUDIT_ROOT_ACL_INVALID" }
        $allowedSidValues = @(
            [string]$currentSid.Value,
            "S-1-5-18",
            "S-1-5-32-544"
        ) | Select-Object -Unique

        # Harden the root first so an untrusted identity cannot add new entries
        # while pre-existing descendants are being normalized. Existing files
        # and directories receive their own protected descriptors as well.
        $pending = New-Object System.Collections.Generic.Stack[System.IO.DirectoryInfo]
        $pending.Push([System.IO.DirectoryInfo]$existing)
        $entryCount = 0
        while ($pending.Count -gt 0) {
            $directory = $pending.Pop()
            Set-M64PrivateAclOnEntry $directory $currentSid $allowedSidValues
            $entryCount += 1
            if ($entryCount -gt 100000) { Fail-Closed "M6_C1_AUDIT_ROOT_ACL_INVALID" }
            foreach ($child in @($directory.GetFileSystemInfos())) {
                if (($child.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
                    Fail-Closed "M6_C1_AUDIT_ROOT_ACL_INVALID"
                }
                if ($child -is [System.IO.DirectoryInfo]) {
                    $pending.Push([System.IO.DirectoryInfo]$child)
                } elseif ($child -is [System.IO.FileInfo]) {
                    Set-M64PrivateAclOnEntry $child $currentSid $allowedSidValues
                    $entryCount += 1
                    if ($entryCount -gt 100000) { Fail-Closed "M6_C1_AUDIT_ROOT_ACL_INVALID" }
                } else {
                    Fail-Closed "M6_C1_AUDIT_ROOT_ACL_INVALID"
                }
            }
        }
    } catch {
        Fail-Closed "M6_C1_AUDIT_ROOT_ACL_INVALID"
    }
}

$runtimeRootFull = Resolve-AbsolutePath $RuntimeRoot "M6_C1_RUNTIME_ROOT_INVALID"
Assert-PlainDirectory $runtimeRootFull "M6_C1_RUNTIME_ROOT_INVALID"
$current = Join-Path $runtimeRootFull "current"
if (-not (Test-Path -LiteralPath $current -PathType Container)) { Fail-Closed "M6_C1_CURRENT_RELEASE_UNAVAILABLE" }
$currentItem = Get-Item -LiteralPath $current -Force
$target = [string]$currentItem.Target
if ([string]::IsNullOrWhiteSpace($target)) { Fail-Closed "M6_C1_CURRENT_RELEASE_UNRESOLVED" }
if (-not [IO.Path]::IsPathRooted($target)) { $target = Join-Path $runtimeRootFull $target }
$releaseRoot = [IO.Path]::GetFullPath($target)
$releasesRoot = [IO.Path]::GetFullPath((Join-Path $runtimeRootFull "releases"))
if (-not (Test-Within $releasesRoot $releaseRoot)) { Fail-Closed "M6_C1_CURRENT_RELEASE_ESCAPE" }
Assert-PlainDirectory $releaseRoot "M6_C1_SOURCE_RELEASE_INVALID"

# The verifier interpreter is launcher-owned machine TCB. Never discover it from
# the release contract: that contract is part of the untrusted tree being checked.
$trustedNodeExecutable = "D:\Program Files\Node\node.exe"
Clear-ProcessEnvironment @("NODE_OPTIONS")
Assert-PlainFile $trustedNodeExecutable "M6_C1_TRUSTED_NODE_INVALID"
$trustedNodeVersion = [string](& $trustedNodeExecutable -p "process.versions.node")
if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($trustedNodeVersion)) {
    Fail-Closed "M6_C1_TRUSTED_NODE_INVALID"
}
$trustedNodeVersion = $trustedNodeVersion.Trim()
Assert-ImmutableSourceRelease $trustedNodeExecutable $runtimeRootFull $current $releaseRoot
if ($VerifyReleaseOnly) {
    [ordered]@{
        ok = $true
        schemaId = "xw.runtime.m6-c1-immutable-release-verification.v1"
        releaseRoot = $releaseRoot
    } | ConvertTo-Json -Depth 3
    return
}

if ([string]::IsNullOrWhiteSpace($ContractPath)) {
    $ContractPath = Join-Path $releaseRoot "config\runtime\xw-runtime.v1.json"
}
$contractPathFull = Resolve-AbsolutePath $ContractPath "M6_C1_CONTRACT_PATH_INVALID"
Assert-PlainFile $contractPathFull "M6_C1_CONTRACT_UNAVAILABLE"
$contract = Get-Content -LiteralPath $contractPathFull -Raw | ConvertFrom-Json
$m6 = $contract.m6C1
$m6Keys = @(
    "schemaId", "runtimeModes", "bindingPath", "bindingSchemaId", "qualificationBindingPath",
    "qualificationBindingSchemaId", "providerBaseUrl", "controlPlaneHost", "controlPlanePort",
    "healthUrl", "gateStatusUrl", "nodeExecutable", "nodeVersion", "requiredSecretEnvironment",
    "requiredOpaqueEnvironment", "qualificationRequiredSecretEnvironment",
    "qualificationRequiredOpaqueEnvironment"
)
if ([string]$contract.schemaId -ne "xw.runtime.layout.v1" -or -not (Test-ExactProperties $m6 $m6Keys) `
    -or [string]$m6.schemaId -ne "xw.runtime.m6-c1-launch-contract.v1" `
    -or [string]$m6.bindingSchemaId -ne "xw.runtime.m6-c1-runtime.v1" `
    -or [string]$m6.qualificationBindingSchemaId -ne "xw.runtime.m6-c1-qualification-bootstrap.v1" `
    -or (@($m6.runtimeModes | ForEach-Object { [string]$_ }) -join "`0") -cne (@("QUALIFICATION_ONLY", "FINAL") -join "`0") `
    -or [string]$m6.providerBaseUrl -ne "https://api.deepseek.com" `
    -or [string]$m6.controlPlaneHost -ne "127.0.0.1" `
    -or [int]$m6.controlPlanePort -ne 17920 `
    -or [string]$m6.healthUrl -ne "http://127.0.0.1:17920/control/v1/health" `
    -or [string]$m6.gateStatusUrl -ne "http://127.0.0.1:17920/control/v1/internal/m6/gate-f/status" `
    -or -not (Test-SamePath ([string]$m6.nodeExecutable) $trustedNodeExecutable) `
    -or [string]$m6.nodeVersion -ne $trustedNodeVersion) {
    Fail-Closed "M6_C1_LAUNCH_CONTRACT_INVALID"
}
$expectedSecretNames = @("DEEPSEEK_API_KEY", "XW_M6_GATE_F_OPERATIONS_TOKEN", "XW_M6_LIVE_ENTRY_TOKEN") | Sort-Object
$actualSecretNames = @($m6.requiredSecretEnvironment | ForEach-Object { [string]$_ } | Sort-Object)
$expectedOpaqueNames = @("XW_M6_ACCOUNT_ISOLATION_BINDING_HASH")
$actualOpaqueNames = @($m6.requiredOpaqueEnvironment | ForEach-Object { [string]$_ })
$expectedQualificationSecretNames = @("XW_M6_GATE_F_OPERATIONS_TOKEN")
$actualQualificationSecretNames = @($m6.qualificationRequiredSecretEnvironment | ForEach-Object { [string]$_ })
$actualQualificationOpaqueNames = @($m6.qualificationRequiredOpaqueEnvironment | ForEach-Object { [string]$_ })
if (($actualSecretNames -join "`0") -cne ($expectedSecretNames -join "`0") `
    -or ($actualOpaqueNames -join "`0") -cne ($expectedOpaqueNames -join "`0") `
    -or ($actualQualificationSecretNames -join "`0") -cne ($expectedQualificationSecretNames -join "`0") `
    -or ($actualQualificationOpaqueNames -join "`0") -cne ($expectedOpaqueNames -join "`0")) {
    Fail-Closed "M6_C1_ENVIRONMENT_CONTRACT_INVALID"
}

$nodeExecutable = $trustedNodeExecutable

$bindingRelative = if ($Mode -eq "QUALIFICATION_ONLY") { [string]$m6.qualificationBindingPath } else { [string]$m6.bindingPath }
if ([string]::IsNullOrWhiteSpace($bindingRelative) -or [IO.Path]::IsPathRooted($bindingRelative) `
    -or $bindingRelative -match '(^|[\\/])\.\.([\\/]|$)') { Fail-Closed "M6_C1_BINDING_PATH_INVALID" }
$bindingPath = [IO.Path]::GetFullPath((Join-Path $runtimeRootFull ($bindingRelative -replace '/', '\')))
if (-not (Test-Within $runtimeRootFull $bindingPath)) { Fail-Closed "M6_C1_BINDING_PATH_INVALID" }
Assert-PlainFile $bindingPath "M6_C1_BINDING_UNAVAILABLE"
$bindingRaw = Get-Content -LiteralPath $bindingPath -Raw
if ($bindingRaw -match '(?i)bearer\s+|"(?:apiKey|token|password|secret|credentialValue)"\s*:') {
    Fail-Closed "M6_C1_BINDING_SECRET_MATERIAL_FORBIDDEN"
}
$binding = $bindingRaw | ConvertFrom-Json
$finalBindingKeys = @(
    "schemaId", "releaseId", "sourceCommit", "sourceReleaseRoot", "releaseManifestSha256",
    "dependencyRoot", "dependencyLayerHash", "modelProfileRoot", "modelProfileHash",
    "providerBaseUrl", "manifestRoot", "runtimeSnapshotPath", "dshPersistenceRoot", "gateId",
    "gateIssuerAllowlistPath", "liveAuthorizationIssuerAllowlistPath",
    "gateFArtifactCatalogPath", "gateFArtifactCatalogHash", "gateFArtifactCatalogSha256", "targetEnvironmentAttestationPath",
    "targetEnvironmentAttestationHash", "environmentQualificationPath", "environmentQualificationSha256",
    "productionDependencyBindingPath", "productionDependencyBindingHash"
)
$qualificationBindingKeys = @(
    "schemaId", "releaseId", "sourceCommit", "sourceReleaseRoot", "releaseManifestSha256",
    "gateId", "gateIssuerAllowlistPath", "gateFArtifactInventoryPath", "gateFArtifactInventoryHash"
)
$expectedBindingKeys = if ($Mode -eq "QUALIFICATION_ONLY") { $qualificationBindingKeys } else { $finalBindingKeys }
$expectedBindingSchema = if ($Mode -eq "QUALIFICATION_ONLY") { [string]$m6.qualificationBindingSchemaId } else { [string]$m6.bindingSchemaId }
if (-not (Test-ExactProperties $binding $expectedBindingKeys) -or [string]$binding.schemaId -ne $expectedBindingSchema `
    -or [string]$binding.releaseId -notmatch '^[A-Za-z0-9._-]{1,128}$' `
    -or [string]$binding.sourceCommit -notmatch '^[0-9a-f]{40}$' `
    -or -not (Test-Hash ([string]$binding.releaseManifestSha256)) `
    -or ($Mode -eq "QUALIFICATION_ONLY" -and -not (Test-Hash ([string]$binding.gateFArtifactInventoryHash))) `
    -or ($Mode -eq "FINAL" -and -not (Test-Hash ([string]$binding.gateFArtifactCatalogHash))) `
    -or [string]$binding.gateId -notmatch '^[A-Za-z0-9._-]{1,128}$') {
    Fail-Closed "M6_C1_BINDING_INVALID"
}
if ($Mode -eq "FINAL" -and (-not (Test-Hash ([string]$binding.dependencyLayerHash)) `
    -or -not (Test-Hash ([string]$binding.modelProfileHash)) `
    -or -not (Test-Hash ([string]$binding.targetEnvironmentAttestationHash)) `
    -or -not (Test-Hash ([string]$binding.environmentQualificationSha256)) `
    -or -not (Test-Hash ([string]$binding.gateFArtifactCatalogSha256)) `
    -or -not (Test-Hash ([string]$binding.productionDependencyBindingHash)) `
    -or [string]$binding.providerBaseUrl -ne [string]$m6.providerBaseUrl)) {
    Fail-Closed "M6_C1_BINDING_INVALID"
}

$boundReleaseRoot = Resolve-AbsolutePath ([string]$binding.sourceReleaseRoot) "M6_C1_SOURCE_RELEASE_INVALID"
if (-not $boundReleaseRoot.Equals($releaseRoot, [StringComparison]::OrdinalIgnoreCase)) { Fail-Closed "M6_C1_RELEASE_REBINDING" }
$manifestPath = Join-Path $releaseRoot "release-manifest.v1.json"
Assert-PlainFile $manifestPath "M6_C1_RELEASE_MANIFEST_UNAVAILABLE"
$manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
if ([string]$manifest.schemaId -ne "xw.runtime.release-manifest.v1" `
    -or [string]$manifest.releaseId -ne [string]$binding.releaseId `
    -or [string]$manifest.sourceCommit -ne [string]$binding.sourceCommit `
    -or [string]$manifest.runtimeProfile -ne [string]$contract.runtimeProfile `
    -or (Get-Sha256 $manifestPath) -ne [string]$binding.releaseManifestSha256) {
    Fail-Closed "M6_C1_RELEASE_BINDING_INVALID"
}

$serverPath = Join-Path $releaseRoot "services\control-plane\control-plane\server.mjs"
if (-not $ValidateOnly) { Assert-PlainFile $serverPath "M6_C1_CONTROL_PLANE_ENTRY_INVALID" }

if ($Mode -eq "QUALIFICATION_ONLY") {
    $gateIssuerPath = Resolve-AbsolutePath ([string]$binding.gateIssuerAllowlistPath) "M6_C1_GATE_ISSUER_INVALID"
    $inventoryPath = Resolve-AbsolutePath ([string]$binding.gateFArtifactInventoryPath) "M6_C1_QUALIFICATION_SENTINEL_INVALID"
    $qualificationSentinelRoot = Join-Path $runtimeRootFull "qualification-bootstrap"
    $liveIssuerPath = Join-Path $qualificationSentinelRoot "live-window-owner-keys-unavailable.json"
    if (-not (Test-Within $qualificationSentinelRoot $inventoryPath) -or (Test-Path -LiteralPath $inventoryPath) `
        -or (Test-Path -LiteralPath $liveIssuerPath)) {
        Fail-Closed "M6_C1_QUALIFICATION_SENTINEL_INVALID"
    }
    Assert-PlainFile $gateIssuerPath "M6_C1_GATE_ISSUER_INVALID"
    $deviceConfigPath = Join-Path $runtimeRootFull "secrets\control-plane.devices.json"
    Assert-PlainFile $deviceConfigPath "M6_C1_QUALIFICATION_DEVICE_CONFIG_INVALID"
    Assert-RequiredEnvironment "XW_M6_GATE_F_OPERATIONS_TOKEN" 32
    Assert-RequiredEnvironment "XW_M6_ACCOUNT_ISOLATION_BINDING_HASH" 64 -Hash

    Clear-ProcessEnvironment @(
        "DEEPSEEK_API_KEY", "XW_M6_LIVE_ENTRY_TOKEN", "XW_M6_LIVE_DEPENDENCY_ROOT",
        "XW_M6_LIVE_DEPENDENCY_LAYER_HASH", "XW_M6_LIVE_PROVIDER_BASE_URL",
        "XW_M6_LIVE_MODEL_PROFILE_ROOT", "XW_M6_LIVE_MODEL_PROFILE_HASH",
        "XW_M6_LIVE_MANIFEST_ROOT", "XW_M6_LIVE_RUNTIME_SNAPSHOT_PATH", "XW_DSH_PERSISTENCE_ROOT",
        "XW_M6_GATE_F_ARTIFACT_CATALOG_PATH", "XW_M6_GATE_F_ARTIFACT_CATALOG_HASH",
        "XW_M6_PRODUCTION_DEPENDENCY_BINDING_PATH", "XW_M6_PRODUCTION_DEPENDENCY_BINDING_HASH",
        "XW_M6_TARGET_ENVIRONMENT_ATTESTATION_PATH", "XW_M6_TARGET_ENVIRONMENT_ATTESTATION_HASH",
        "XW_M6_ENVIRONMENT_QUALIFICATION_PATH", "XW_M6_ENVIRONMENT_QUALIFICATION_SHA256"
    )
    $env:XW_RELEASE_MANIFEST = $manifestPath
    $env:CONTROL_PLANE_HOST = [string]$m6.controlPlaneHost
    $env:CONTROL_PLANE_PORT = [string]$m6.controlPlanePort
    $env:CONTROL_PLANE_DB = Join-Path $runtimeRootFull "state\control-plane\control.db"
    $env:CONTROL_PLANE_RUNS_ROOT = Join-Path $runtimeRootFull "evidence"
    $env:CONTROL_PLANE_DEVICES_FILE = $deviceConfigPath
    $env:CONTROL_PLANE_EXPECTED_HOST = "DESKTOP-3I1EVHE"
    $env:CONTROL_PLANE_NODE_ID = "DESKTOP-3I1EVHE"
    $env:CONTROL_PLANE_NODE_VERSION = [string]$m6.nodeVersion
    $env:CONTROL_PLANE_GIT_COMMIT = [string]$manifest.sourceCommit
    $env:CONTROL_PLANE_RELEASE_ID = [string]$manifest.releaseId
    $env:AUTONOMY_POLICY_MODE = "legacy"
    $env:MISSION_AUTO_APPROVAL_ENABLED = "0"
    $env:STANDING_GRANT_ENABLED = "0"
    $env:CONTROL_PLANE_PILOT_ACTORS = '[]'
    $env:CONTROL_PLANE_PILOT_ALIASES = '[]'
    $env:CONTROL_PLANE_LEGACY_MODE = "enforce"
    $env:XHS_RECIPE_OVERLAY_MODE = "off"
    $env:NODE_NO_WARNINGS = "1"
    $env:M6_ENABLED = "0"
    $env:M6_LIVE_ENTRY_ENABLED = "0"
    $env:M6_GATE_F_OPERATIONS_ENABLED = "1"
    $env:XW_M6_RUNTIME_MODE = "QUALIFICATION_ONLY"
    $env:XW_RUNTIME_ROOT = $runtimeRootFull
    $env:XW_GATE_ID = [string]$binding.gateId
    $env:XW_GATE_ISSUER_KEYS_PATH = $gateIssuerPath
    $env:XW_M6_LIVE_AUTH_ISSUER_KEYS_PATH = $liveIssuerPath
    $env:XW_M6_GATE_F_ARTIFACT_INVENTORY_PATH = $inventoryPath
    $env:XW_M6_GATE_F_ARTIFACT_INVENTORY_HASH = [string]$binding.gateFArtifactInventoryHash

    $receipt = [ordered]@{
        ok = $true
        schemaId = "xw.runtime.m6-c1-launch-validation.v1"
        runtimeMode = "QUALIFICATION_ONLY"
        releaseId = [string]$binding.releaseId
        sourceCommit = [string]$binding.sourceCommit
        gateFArtifactInventory = "deliberately-unavailable-for-mutations"
        routeSet = @("health", "gate-status", "alias01-device-binding", "qualification-job-submit", "qualification-job-status")
        requiredEnvironment = [ordered]@{
            XW_M6_GATE_F_OPERATIONS_TOKEN = "present"
            XW_M6_ACCOUNT_ISOLATION_BINDING_HASH = "present"
        }
    }
    if ($ValidateOnly) {
        $receipt | ConvertTo-Json -Depth 5
        return
    }
    Initialize-M64PrivateAuditRoot $runtimeRootFull
    & $nodeExecutable $serverPath serve *>> (Join-Path $runtimeRootFull "logs\control-plane.log")
    if ($LASTEXITCODE -ne 0) { Fail-Closed "M6_C1_CONTROL_PLANE_EXITED" }
    return
}

$dependencyRoot = Resolve-AbsolutePath ([string]$binding.dependencyRoot) "M6_C1_DEPENDENCY_ROOT_INVALID"
$modelProfileRoot = Resolve-AbsolutePath ([string]$binding.modelProfileRoot) "M6_C1_MODEL_ROOT_INVALID"
$manifestRoot = Resolve-AbsolutePath ([string]$binding.manifestRoot) "M6_C1_MANIFEST_ROOT_INVALID"
$runtimeSnapshotPath = Resolve-AbsolutePath ([string]$binding.runtimeSnapshotPath) "M6_C1_RUNTIME_SNAPSHOT_INVALID"
$persistenceRoot = Resolve-AbsolutePath ([string]$binding.dshPersistenceRoot) "M6_C1_PERSISTENCE_ROOT_INVALID"
$gateIssuerPath = Resolve-AbsolutePath ([string]$binding.gateIssuerAllowlistPath) "M6_C1_GATE_ISSUER_INVALID"
$liveIssuerPath = Resolve-AbsolutePath ([string]$binding.liveAuthorizationIssuerAllowlistPath) "M6_C1_LIVE_ISSUER_INVALID"
$catalogPath = Resolve-AbsolutePath ([string]$binding.gateFArtifactCatalogPath) "M6_C1_GATE_F_CATALOG_INVALID"
$targetEnvironmentPath = Resolve-AbsolutePath ([string]$binding.targetEnvironmentAttestationPath) "M6_C1_TARGET_ENVIRONMENT_INVALID"
$environmentQualificationPath = Resolve-AbsolutePath ([string]$binding.environmentQualificationPath) "M6_C1_ENVIRONMENT_QUALIFICATION_INVALID"
$productionDependencyBindingPath = Resolve-AbsolutePath ([string]$binding.productionDependencyBindingPath) "M6_C1_PRODUCTION_DEPENDENCY_BINDING_INVALID"
if ((Test-Within $releaseRoot $dependencyRoot) -or (Test-Within $releaseRoot $modelProfileRoot) `
    -or (Test-Within $releaseRoot $persistenceRoot) -or (Test-Within $dependencyRoot $modelProfileRoot) `
    -or (Test-Within $dependencyRoot $persistenceRoot) `
    -or (Test-Within $releaseRoot $productionDependencyBindingPath)) { Fail-Closed "M6_C1_MUTABLE_ROOT_REBINDING" }
Assert-PlainDirectory $dependencyRoot "M6_C1_DEPENDENCY_ROOT_INVALID"
Assert-PlainDirectory $modelProfileRoot "M6_C1_MODEL_ROOT_INVALID"
Assert-PlainDirectory $manifestRoot "M6_C1_MANIFEST_ROOT_INVALID"
Assert-PlainDirectory $persistenceRoot "M6_C1_PERSISTENCE_ROOT_INVALID"
Assert-PlainFile $runtimeSnapshotPath "M6_C1_RUNTIME_SNAPSHOT_INVALID"
Assert-PlainFile $gateIssuerPath "M6_C1_GATE_ISSUER_INVALID"
Assert-PlainFile $liveIssuerPath "M6_C1_LIVE_ISSUER_INVALID"
Assert-PlainFile $catalogPath "M6_C1_GATE_F_CATALOG_INVALID"
Assert-PlainFile $targetEnvironmentPath "M6_C1_TARGET_ENVIRONMENT_INVALID"
Assert-PlainFile $environmentQualificationPath "M6_C1_ENVIRONMENT_QUALIFICATION_INVALID"
Assert-PlainFile $productionDependencyBindingPath "M6_C1_PRODUCTION_DEPENDENCY_BINDING_INVALID"
if ((Get-Sha256 $catalogPath) -ne [string]$binding.gateFArtifactCatalogSha256) { Fail-Closed "M6_C1_GATE_F_CATALOG_HASH_MISMATCH" }
Assert-GateFCatalog $nodeExecutable $catalogPath ([string]$binding.gateFArtifactCatalogHash) ([string]$binding.releaseId) ([string]$binding.sourceCommit) $releaseRoot $manifestPath
if ((Get-Sha256 $environmentQualificationPath) -ne [string]$binding.environmentQualificationSha256) { Fail-Closed "M6_C1_ENVIRONMENT_QUALIFICATION_HASH_MISMATCH" }
if ((Get-Sha256 $productionDependencyBindingPath) -ne [string]$binding.productionDependencyBindingHash) { Fail-Closed "M6_C1_PRODUCTION_DEPENDENCY_BINDING_HASH_MISMATCH" }
$targetEnvironment = Get-Content -LiteralPath $targetEnvironmentPath -Raw | ConvertFrom-Json
$environmentQualification = Get-Content -LiteralPath $environmentQualificationPath -Raw | ConvertFrom-Json
$artifactCatalog = Get-Content -LiteralPath $catalogPath -Raw | ConvertFrom-Json
$artifactInventories = @($artifactCatalog.entries | ForEach-Object {
    Get-Content -LiteralPath ([string]$_.inventoryPath) -Raw | ConvertFrom-Json
})
$targetEnvironmentKeys = @(
    "schemaId", "appPackageHash", "appBuildHash", "signingHash", "osBuildHash", "displayHash",
    "localeThemeHash", "imeHash", "accessibilityHash", "accountIsolationHash", "capturedAt", "expiresAt", "attestationHash"
)
$environmentQualificationKeys = @(
    "schemaId", "status", "gateFEligible", "alias", "effectBoundary", "commandRegistryHash",
    "qualifiedAttestationHashes", "sampleCount", "capturedAt", "expiresAt", "secretMaterialPresent",
    "rawDeviceIdentityPresent", "actionCount"
)
$targetCaptured = [DateTimeOffset]::Parse([string]$targetEnvironment.capturedAt)
$targetExpires = [DateTimeOffset]::Parse([string]$targetEnvironment.expiresAt)
$targetHashFields = @(
    $targetEnvironment.appPackageHash, $targetEnvironment.appBuildHash, $targetEnvironment.signingHash,
    $targetEnvironment.osBuildHash, $targetEnvironment.displayHash, $targetEnvironment.localeThemeHash,
    $targetEnvironment.imeHash, $targetEnvironment.accessibilityHash, $targetEnvironment.accountIsolationHash,
    $targetEnvironment.attestationHash
)
if (-not (Test-ExactProperties $targetEnvironment $targetEnvironmentKeys) `
    -or -not (Test-ExactProperties $environmentQualification $environmentQualificationKeys) `
    -or @($targetHashFields | Where-Object { -not (Test-Hash ([string]$_)) }).Count -ne 0 `
    -or [string]$targetEnvironment.schemaId -ne "xw.m6-target-environment-attestation.v1" `
    -or [string]$targetEnvironment.attestationHash -ne [string]$binding.targetEnvironmentAttestationHash `
    -or $targetCaptured -gt [DateTimeOffset]::UtcNow.AddSeconds(5) `
    -or $targetExpires -le [DateTimeOffset]::UtcNow `
    -or ($targetExpires - $targetCaptured).TotalMilliseconds -ne (6 * 60 * 60 * 1000) `
    -or [string]$environmentQualification.schemaId -ne "xw.m6-environment-qualification.v1" `
    -or [string]$environmentQualification.status -ne "QUALIFIED" -or [bool]$environmentQualification.gateFEligible -ne $true `
    -or [string]$environmentQualification.alias -ne "01" -or [string]$environmentQualification.effectBoundary -ne "READ_ONLY" `
    -or [int]$environmentQualification.sampleCount -ne 2 -or [int]$environmentQualification.actionCount -ne 0 `
    -or [bool]$environmentQualification.secretMaterialPresent -ne $false -or [bool]$environmentQualification.rawDeviceIdentityPresent -ne $false `
    -or -not (Test-Hash ([string]$environmentQualification.commandRegistryHash)) `
    -or @($environmentQualification.qualifiedAttestationHashes).Count -ne 1 `
    -or [string]$environmentQualification.qualifiedAttestationHashes[0] -ne [string]$binding.targetEnvironmentAttestationHash `
    -or [string]$environmentQualification.capturedAt -ne [string]$targetEnvironment.capturedAt `
    -or [string]$environmentQualification.expiresAt -ne [string]$targetEnvironment.expiresAt `
    -or [string]$artifactCatalog.schemaId -ne "xw.m6-gate-f-artifact-catalog.v1" `
    -or [string]$artifactCatalog.catalogHash -ne [string]$binding.gateFArtifactCatalogHash `
    -or @($artifactInventories | Where-Object {
        -not (Test-SamePath ([string]$_.runtimeArtifacts.environmentAttestation.path) $targetEnvironmentPath) `
        -or -not (Test-SamePath ([string]$_.lockArtifacts.environmentQualification.path) $environmentQualificationPath)
    }).Count -ne 0) {
    Fail-Closed "M6_C1_ENVIRONMENT_BINDING_INVALID"
}

$layerManifestPath = Join-Path $dependencyRoot "m6-live-runtime-dependency-layer.v1.json"
Assert-PlainFile $layerManifestPath "M6_C1_DEPENDENCY_MANIFEST_INVALID"
$layerManifest = Get-Content -LiteralPath $layerManifestPath -Raw | ConvertFrom-Json
if ([string]$layerManifest.schemaId -ne "xw.m6-live-runtime-dependency-layer.v1" `
    -or [string]$layerManifest.layerHash -ne [string]$binding.dependencyLayerHash `
    -or [string]$layerManifest.sourceRelease.releaseId -ne [string]$binding.releaseId `
    -or [string]$layerManifest.sourceRelease.sourceCommit -ne [string]$binding.sourceCommit `
    -or [string]$layerManifest.sourceRelease.manifestSha256 -ne [string]$binding.releaseManifestSha256) {
    Fail-Closed "M6_C1_DEPENDENCY_BINDING_INVALID"
}
$profilePath = Join-Path $modelProfileRoot (([string]$binding.modelProfileHash) + ".json")
Assert-PlainFile $profilePath "M6_C1_MODEL_PROFILE_INVALID"
$profile = Get-Content -LiteralPath $profilePath -Raw | ConvertFrom-Json
if ([string]$profile.schemaId -ne "xw.m6-live-model-profile.v1" -or [string]$profile.status -ne "QUALIFIED" `
    -or [bool]$profile.gateFEligible -ne $true -or [string]$profile.contentHash -ne [string]$binding.modelProfileHash `
    -or [string]$profile.provider -ne "deepseek-official" `
    -or [string]$profile.targetEnvironmentAttestationHash -ne [string]$binding.targetEnvironmentAttestationHash `
    -or [DateTimeOffset]::Parse([string]$profile.expiresAt) -le [DateTimeOffset]::UtcNow `
    -or [DateTimeOffset]::Parse([string]$profile.expiresAt) -gt [DateTimeOffset]::Parse([string]$targetEnvironment.expiresAt)) {
    Fail-Closed "M6_C1_MODEL_PROFILE_INVALID"
}

Assert-RequiredEnvironment "DEEPSEEK_API_KEY" 8
Assert-RequiredEnvironment "XW_M6_GATE_F_OPERATIONS_TOKEN" 32
Assert-RequiredEnvironment "XW_M6_LIVE_ENTRY_TOKEN" 32
Assert-RequiredEnvironment "XW_M6_ACCOUNT_ISOLATION_BINDING_HASH" 64 -Hash
$gateOperationsToken = [Environment]::GetEnvironmentVariable("XW_M6_GATE_F_OPERATIONS_TOKEN", "Process")
$liveEntryToken = [Environment]::GetEnvironmentVariable("XW_M6_LIVE_ENTRY_TOKEN", "Process")
if ([string]::Equals($gateOperationsToken, $liveEntryToken, [StringComparison]::Ordinal)) {
    Fail-Closed "M6_C1_AUTHORITY_TOKEN_SEPARATION_REQUIRED"
}

$env:XW_RELEASE_MANIFEST = $manifestPath
$env:CONTROL_PLANE_HOST = [string]$m6.controlPlaneHost
$env:CONTROL_PLANE_PORT = [string]$m6.controlPlanePort
$env:CONTROL_PLANE_DB = Join-Path $runtimeRootFull "state\control-plane\control.db"
$env:CONTROL_PLANE_RUNS_ROOT = Join-Path $runtimeRootFull "evidence"
$env:CONTROL_PLANE_DEVICES_FILE = Join-Path $runtimeRootFull "secrets\control-plane.devices.json"
$env:CONTROL_PLANE_EXPECTED_HOST = "DESKTOP-3I1EVHE"
$env:CONTROL_PLANE_NODE_ID = "DESKTOP-3I1EVHE"
$env:CONTROL_PLANE_NODE_VERSION = [string]$m6.nodeVersion
$env:CONTROL_PLANE_GIT_COMMIT = [string]$manifest.sourceCommit
$env:CONTROL_PLANE_RELEASE_ID = [string]$manifest.releaseId
$env:AUTONOMY_POLICY_MODE = "nonpayment_v1"
$env:EVIDENCE_MODE = "dual"
$env:CONTROL_PLANE_PILOT_ACTORS = '["claude-pilot-20260809"]'
$env:CONTROL_PLANE_PILOT_ALIASES = '["01","02","03","04"]'
$env:CONTROL_PLANE_LEGACY_MODE = "enforce"
$env:XHS_RECIPE_OVERLAY_MODE = "off"
$env:NODE_NO_WARNINGS = "1"
$env:M6_ENABLED = "1"
$env:M6_LIVE_ENTRY_ENABLED = "1"
$env:M6_GATE_F_OPERATIONS_ENABLED = "1"
$env:XW_M6_RUNTIME_MODE = "FINAL"
$env:XW_RUNTIME_ROOT = $runtimeRootFull
$env:XW_GATE_ID = [string]$binding.gateId
$env:XW_GATE_ISSUER_KEYS_PATH = $gateIssuerPath
$env:XW_M6_SOURCE_RELEASE_ROOT = $releaseRoot
$env:XW_M6_LIVE_DEPENDENCY_ROOT = $dependencyRoot
$env:XW_M6_LIVE_DEPENDENCY_LAYER_HASH = [string]$binding.dependencyLayerHash
$env:XW_M6_LIVE_PROVIDER_BASE_URL = [string]$binding.providerBaseUrl
$env:XW_M6_LIVE_MODEL_PROFILE_ROOT = $modelProfileRoot
$env:XW_M6_LIVE_MODEL_PROFILE_HASH = [string]$binding.modelProfileHash
$env:XW_M6_LIVE_MANIFEST_ROOT = $manifestRoot
$env:XW_M6_LIVE_RUNTIME_SNAPSHOT_PATH = $runtimeSnapshotPath
$env:XW_DSH_PERSISTENCE_ROOT = $persistenceRoot
$env:XW_M6_LIVE_AUTH_ISSUER_KEYS_PATH = $liveIssuerPath
Clear-ProcessEnvironment @("XW_M6_GATE_F_ARTIFACT_INVENTORY_PATH", "XW_M6_GATE_F_ARTIFACT_INVENTORY_HASH")
$env:XW_M6_GATE_F_ARTIFACT_CATALOG_PATH = $catalogPath
$env:XW_M6_GATE_F_ARTIFACT_CATALOG_HASH = [string]$binding.gateFArtifactCatalogHash
$env:XW_M6_PRODUCTION_DEPENDENCY_BINDING_PATH = $productionDependencyBindingPath
$env:XW_M6_PRODUCTION_DEPENDENCY_BINDING_HASH = [string]$binding.productionDependencyBindingHash
$env:XW_M6_TARGET_ENVIRONMENT_ATTESTATION_PATH = $targetEnvironmentPath
$env:XW_M6_TARGET_ENVIRONMENT_ATTESTATION_HASH = [string]$binding.targetEnvironmentAttestationHash
$env:XW_M6_ENVIRONMENT_QUALIFICATION_PATH = $environmentQualificationPath
$env:XW_M6_ENVIRONMENT_QUALIFICATION_SHA256 = [string]$binding.environmentQualificationSha256

$receipt = [ordered]@{
    ok = $true
    schemaId = "xw.runtime.m6-c1-launch-validation.v1"
    runtimeMode = "FINAL"
    releaseId = [string]$binding.releaseId
    sourceCommit = [string]$binding.sourceCommit
    dependencyLayerHash = [string]$binding.dependencyLayerHash
    modelProfileHash = [string]$binding.modelProfileHash
    gateFArtifactCatalogHash = [string]$binding.gateFArtifactCatalogHash
    productionDependencyBindingHash = [string]$binding.productionDependencyBindingHash
    requiredEnvironment = [ordered]@{
        DEEPSEEK_API_KEY = "present"
        XW_M6_GATE_F_OPERATIONS_TOKEN = "present"
        XW_M6_LIVE_ENTRY_TOKEN = "present"
        XW_M6_ACCOUNT_ISOLATION_BINDING_HASH = "present"
    }
}
if ($ValidateOnly) {
    $receipt | ConvertTo-Json -Depth 5
    return
}

Initialize-M64PrivateAuditRoot $runtimeRootFull
& $nodeExecutable $serverPath serve *>> (Join-Path $runtimeRootFull "logs\control-plane.log")
if ($LASTEXITCODE -ne 0) { Fail-Closed "M6_C1_CONTROL_PLANE_EXITED" }
