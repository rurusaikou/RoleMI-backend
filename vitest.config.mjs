import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig({
	plugins: [
		cloudflareTest({
			remoteBindings: false,
			miniflare: { bindings: { AI_API_KEY: "test-only-secret", AI_QUOTA_DISABLED: false, AI_INSTALLATION_DAILY_LIMIT: 20, AI_INSTALLATION_MINUTE_LIMIT: 6, AI_GLOBAL_DAILY_LIMIT: 200 } },
			wrangler: { configPath: "./wrangler.jsonc" },
		}),
	],
});
