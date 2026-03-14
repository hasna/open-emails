import type { Provider } from "../types/index.js";
import { ProviderConfigError } from "../types/index.js";
import type { ProviderAdapter } from "./interface.js";
import { ResendAdapter } from "./resend.js";
import { SESAdapter } from "./ses.js";
import { GmailAdapter } from "./gmail.js";
import { SandboxAdapter } from "./sandbox.js";

export function getAdapter(provider: Provider): ProviderAdapter {
  switch (provider.type) {
    case "resend":
      return new ResendAdapter(provider);
    case "ses":
      return new SESAdapter(provider);
    case "gmail":
      return new GmailAdapter(provider);
    case "sandbox":
      return new SandboxAdapter(provider);
    default:
      throw new ProviderConfigError(`Unknown provider type: ${provider.type}`);
  }
}

export { ResendAdapter } from "./resend.js";
export { SESAdapter } from "./ses.js";
export { GmailAdapter } from "./gmail.js";
export { SandboxAdapter } from "./sandbox.js";
export type { ProviderAdapter, RemoteDomain, RemoteAddress, RemoteEvent } from "./interface.js";
