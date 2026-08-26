/**
 * Fixture: xhs.search.fixed — PR1 single-device RPA smoke recipe (R0, no social effects).
 *
 * Coordinates are placeholders bound to alias 04; calibrate on the real device
 * before live smoke (deviceProfile.appVersion / x,y must match the phone).
 */
export const XHS_SEARCH_FIXED_RECIPE = Object.freeze({
  schemaId: "xhs.recipe.v1",
  recipeId: "xhs.search.fixed",
  revision: 1,
  status: "canary_only",
  appId: "xhs",
  riskCeiling: "R0",
  eligibleAliases: ["04"],
  executionMode: "single_device_fixed",
  descriptorHash: "0".repeat(64),
  deviceProfile: {
    alias: "04",
    package: "com.xingin.xhs",
    appVersion: "9.10.113",
    width: 1080,
    height: 2400,
    orientation: "portrait",
  },
  inputSchema: {
    type: "object",
    required: ["keyword"],
    additionalProperties: false,
    properties: {
      keyword: { type: "string", minLength: 1, maxLength: 50 },
      pages: { type: "integer", minimum: 0, maximum: 5 },
    },
  },
  failurePolicy: {
    default: "STOP_AND_CAPTURE",
    maxStepRetries: 1,
  },
  executor: {
    kind: "primitive_steps",
    steps: [
      {
        id: "launch_xhs",
        kind: "launch",
        params: { appId: "com.xingin.xhs" },
        postAssertions: [{ type: "packageEquals", value: "com.xingin.xhs" }],
      },
      {
        id: "settle_home",
        kind: "wait",
        params: { ms: 800 },
      },
      {
        id: "tap_search",
        kind: "tapSelector",
        params: {
          x: 1005,
          y: 156,
          deviceBound: { alias: "04", appVersion: "9.10.113" },
        },
      },
      {
        id: "wait_search_box",
        kind: "wait",
        params: { ms: 500 },
      },
      {
        id: "tap_input",
        kind: "tapSelector",
        params: {
          x: 520,
          y: 160,
          deviceBound: { alias: "04", appVersion: "9.10.113" },
        },
      },
      {
        id: "input_keyword",
        kind: "input",
        params: {
          text: "$input.keyword",
          enter: true,
        },
        postAssertions: [
          { type: "activityContains", value: "Search" },
        ],
      },
      {
        id: "swipe_page_1",
        kind: "swipe",
        params: {
          from: { x: 540, y: 1800 },
          to: { x: 540, y: 600 },
          deviceBound: { alias: "04", appVersion: "9.10.113" },
        },
      },
      {
        id: "capture_result",
        kind: "screenshot",
        params: { label: "search-result" },
      },
      {
        id: "return_home",
        kind: "back",
        params: {},
        postAssertions: [{ type: "packageEquals", value: "com.xingin.xhs" }],
      },
    ],
  },
});
