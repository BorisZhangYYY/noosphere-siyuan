import type { Settings } from "../types";

/** Accept a service root, version base, or full endpoint without duplicating API path segments. */
export function modelEndpoint(baseUrl: string, suffix: string, format: Settings["modelFormat"] = "openai_chat"): string {
  const endpoint = new URL(baseUrl.trim());
  if (!["http:", "https:"].includes(endpoint.protocol)) throw new Error("模型地址必须是 HTTP 或 HTTPS");
  const version = format === "google" ? "/v1beta" : "/v1";
  let path = endpoint.pathname.replace(/\/$/, "");
  if (path.endsWith(suffix)) return endpoint.href;
  if (!/\/v\d+(?:beta)?$/.test(path)) path += version;
  endpoint.pathname = `${path}${suffix}`;
  return endpoint.href;
}
