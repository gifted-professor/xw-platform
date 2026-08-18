import { readFile } from "node:fs/promises";
import { extname, resolve } from "node:path";

function arg(name, fallback = "") {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

const imagePath = arg("--image");
const promptPath = arg("--prompt", "prompts/xhs-page-classifier.txt");
const outputPath = arg("--output");
const apiUrl = process.env.VISION_API_URL;
const apiKey = process.env.VISION_API_KEY;
const model = process.env.VISION_MODEL;

if (!imagePath || !apiUrl || !apiKey || !model) {
  throw new Error("需要 --image，并设置 VISION_API_URL、VISION_API_KEY、VISION_MODEL");
}

const mimeByExt = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp" };
const absoluteImage = resolve(imagePath);
const mime = mimeByExt[extname(absoluteImage).toLowerCase()];
if (!mime) throw new Error("仅支持 PNG、JPEG 或 WebP 截图");

const [image, systemPrompt] = await Promise.all([
  readFile(absoluteImage),
  readFile(resolve(promptPath), "utf8"),
]);

const response = await fetch(apiUrl, {
  method: "POST",
  headers: {
    "content-type": "application/json",
    authorization: `Bearer ${apiKey}`,
  },
  body: JSON.stringify({
    model,
    temperature: 0,
    response_format: { type: "json_object" },
    messages: [
      { role: "system", content: systemPrompt },
      {
        role: "user",
        content: [
          { type: "text", text: "Classify this current device screen. Return JSON only." },
          { type: "image_url", image_url: { url: `data:${mime};base64,${image.toString("base64")}` } },
        ],
      },
    ],
  }),
});

const body = await response.json();
if (!response.ok) throw new Error(`Vision API ${response.status}: ${JSON.stringify(body)}`);
const content = body?.choices?.[0]?.message?.content;
if (!content) throw new Error("云端视觉接口未返回 choices[0].message.content");

JSON.parse(content);
if (outputPath) await import("node:fs/promises").then(({ writeFile }) => writeFile(resolve(outputPath), `${content}\n`, "utf8"));
process.stdout.write(`${content}\n`);

