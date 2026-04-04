import { existsSync, readFileSync } from "node:fs";

interface ApiKeyCredential {
	readonly type: "api_key";
	readonly key: string;
}

type AuthCredential = ApiKeyCredential | { readonly type: string; readonly key?: string };
type AuthStorageData = Record<string, AuthCredential>;

export class AuthStorage {
	private readonly runtimeApiKeys = new Map<string, string>();
	private readonly data: AuthStorageData;

	private constructor(private readonly authPath?: string) {
		this.data = this.load();
	}

	static create(authPath?: string): AuthStorage {
		return new AuthStorage(authPath);
	}

	setRuntimeApiKey(provider: string, apiKey: string): void {
		this.runtimeApiKeys.set(provider, apiKey);
	}

	getApiKey(provider: string): string | undefined {
		const runtimeKey = this.runtimeApiKeys.get(provider);
		if (runtimeKey) {
			return runtimeKey;
		}

		const stored = this.data[provider];
		if (stored?.type === "api_key" && typeof stored.key === "string" && stored.key.length > 0) {
			return stored.key;
		}

		return undefined;
	}

	private load(): AuthStorageData {
		if (!this.authPath || !existsSync(this.authPath)) {
			return {};
		}

		try {
			return JSON.parse(readFileSync(this.authPath, "utf8")) as AuthStorageData;
		} catch {
			return {};
		}
	}
}
