/**
 * Model detection utilities for pi-free-providers.
 * Extracts and adapts model family detection from pi-models.
 * Used for failover when providers hit rate limits.
 */

import type { Model } from "@mariozechner/pi-ai";
import type { ProviderModelConfig } from "./types.ts";

export interface ModelInfo {
	id: string;
	name?: string;
	provider: string;
	isFree: boolean;
	inputCost: number;
	outputCost: number;
}

export interface ModelFamily {
	id: string; // Normalized family ID (e.g., "claude-sonnet")
	displayName: string; // Human readable (e.g., "Claude Sonnet")
	models: ModelInfo[]; // All models in this family
}

/**
 * Check if a model is free (zero input and output cost)
 */
export function isModelFree(model: {
	cost?: { input: number; output: number };
}): boolean {
	if (!model.cost) return true;
	return model.cost.input === 0 && model.cost.output === 0;
}

/**
 * Convert Pi's Model type to ModelInfo for internal use
 */
export function toModelInfo(model: Model<any>): ModelInfo {
	return {
		id: model.id,
		name: model.name,
		provider: model.provider,
		isFree: isModelFree(model),
		inputCost: model.cost?.input ?? 0,
		outputCost: model.cost?.output ?? 0,
	};
}

/**
 * Convert ProviderModelConfig to ModelInfo for internal use
 */
export function toProviderModelInfo(model: ProviderModelConfig): ModelInfo {
	return {
		id: model.id,
		name: model.name,
		provider: "", // Will be set by caller
		isFree: isModelFree(model),
		inputCost: model.cost?.input ?? 0,
		outputCost: model.cost?.output ?? 0,
	};
}

/**
 * Detect the model family from a model's ID or name.
 * Returns the family ID and display name.
 */
export function detectModelFamily(
	model: ModelInfo,
): { familyId: string; familyName: string } | null {
	const id = model.id.toLowerCase();
	const name = (model.name || "").toLowerCase();
	const fullText = `${id} ${name}`;

	// Router models (gateways to free models) - group into "other"
	if (/\brouter\b/.test(fullText) || /\bauto\b/.test(fullText) || id === "kilo-auto/free") {
		return { familyId: "other", familyName: "Other" };
	}

	// Known brand keywords - order matters: more specific/longer matches first
	const brandMappings: {
		keywords: string[];
		familyId: string;
		familyName: string;
	}[] = [
		{ keywords: ["claude"], familyId: "claude", familyName: "Claude" },
		{ keywords: ["deepseek"], familyId: "deepseek", familyName: "DeepSeek" },
		{ keywords: ["gemini"], familyId: "gemini", familyName: "Gemini" },
		{ keywords: ["gpt"], familyId: "gpt", familyName: "GPT" },
		{ keywords: ["llama"], familyId: "llama", familyName: "Llama" },
		{ keywords: ["minimax"], familyId: "minimax", familyName: "MiniMax" },
		{ keywords: ["qwen"], familyId: "qwen", familyName: "Qwen" },
		{ keywords: ["nemotron"], familyId: "nemotron", familyName: "Nemotron" },
		{ keywords: ["kimi", "moonshot"], familyId: "kimi", familyName: "Kimi" },
		{ keywords: ["glm", "chatglm"], familyId: "glm", familyName: "GLM" },
		{ keywords: ["mistral"], familyId: "mistral", familyName: "Mistral" },
		{ keywords: ["arcee", "trinity"], familyId: "arcee", familyName: "Arcee" },
		{ keywords: ["o1", "o3"], familyId: "openai-o", familyName: "OpenAI o" },
	];

	// Check for known brands in ID or name
	for (const mapping of brandMappings) {
		for (const keyword of mapping.keywords) {
			if (fullText.includes(keyword)) {
				return { familyId: mapping.familyId, familyName: mapping.familyName };
			}
		}
	}

	// Provider-specific fallbacks for models without brand in ID/name
	const providerMappings: Record<string, { familyId: string; familyName: string }> = {
		minimax: { familyId: "minimax", familyName: "MiniMax" },
		minimaxai: { familyId: "minimax", familyName: "MiniMax" },
		deepseek: { familyId: "deepseek", familyName: "DeepSeek" },
		nvidia: { familyId: "nemotron", familyName: "Nemotron" },
		moonshot: { familyId: "kimi", familyName: "Kimi" },
		zhipu: { familyId: "glm", familyName: "GLM" },
	};

	if (providerMappings[model.provider]) {
		return providerMappings[model.provider];
	}

	// Helper to find brand in ID parts
	function findBrandInParts(parts: string[]): { familyId: string; familyName: string } | null {
		for (const part of parts) {
			for (const mapping of brandMappings) {
				for (const keyword of mapping.keywords) {
					if (part.includes(keyword)) {
						return { familyId: mapping.familyId, familyName: mapping.familyName };
					}
				}
			}
		}
		return null;
	}

	// Smart fallback: try to identify brand from model ID structure
	const parts = id.split(/[-_:.@]/);
	const firstPart = parts[0];

	// If ID starts with a version number, check remaining parts for brand
	if (firstPart && /^v?\d+(\.\d+)?$/.test(firstPart)) {
		const brandFromParts = findBrandInParts(parts.slice(1));
		if (brandFromParts) {
			return brandFromParts;
		}
	}

	// If ID has multiple parts, check ALL parts for brand keywords
	if (parts.length > 1) {
		const brandFromParts = findBrandInParts(parts);
		if (brandFromParts) {
			return brandFromParts;
		}

		// Use first part as brand if it looks brand-like
		if (firstPart && !/^v?\d+(\.\d+)?$/.test(firstPart)) {
			return {
				familyId: firstPart,
				familyName: firstPart.charAt(0).toUpperCase() + firstPart.slice(1),
			};
		}
	}

	// Last resort: use first non-version part
	if (firstPart && /^v?\d+(\.\d+)?$/.test(firstPart) && parts.length > 1) {
		for (let i = 1; i < parts.length; i++) {
			const part = parts[i];
			if (
				part &&
				!/^v?\d+(\.\d+)?$/.test(part) &&
				!["latest", "preview", "rc", "beta", "alpha", "dev", "free"].includes(part)
			) {
				return {
					familyId: part,
					familyName: part.charAt(0).toUpperCase() + part.slice(1),
				};
			}
		}
	}

	return {
		familyId: firstPart || id,
		familyName: (firstPart || id).charAt(0).toUpperCase() + (firstPart || id).slice(1),
	};
}

/**
 * Normalize a model name for comparison by removing provider-specific suffixes
 * and common qualifiers. This helps detect when the same model is offered by
 * multiple providers with slightly different naming.
 */
export function normalizeModelName(name: string): string {
	return (
		name
			.toLowerCase()
			// Remove common suffixes added by providers
			.replace(/\s*\(free\)\s*$/i, "")
			.replace(/\s*\(cline\)\s*$/i, "")
			.replace(/\s*\(ci:\s*[\d.]+\)\s*$/i, "")
			.replace(/\s*\[ci:\s*[\d.]+\]\s*$/i, "")
			.replace(/\s*\([^)]*\)\s*$/g, "") // Remove any trailing parenthetical
			.replace(/\s*-\s*free\s*$/i, "") // e.g., "minimax-m2.5-free"
			.replace(/\s*free\s*$/i, "") // trailing "free"
			.trim()
	);
}

/**
 * Get all model families from a list of models.
 * Groups models by family and merges same-name models across providers.
 */
export function getModelFamilies(models: ModelInfo[]): ModelFamily[] {
	const byFamily = new Map<string, ModelInfo[]>();
	const nameToFamilyId = new Map<string, string>();

	for (const model of models) {
		const family = detectModelFamily(model);
		if (!family) continue;

		const existing = byFamily.get(family.familyId) ?? [];
		existing.push(model);
		byFamily.set(family.familyId, existing);
	}

	// Second pass: merge families with models that have the same normalized name
	const familyIds = [...byFamily.keys()];
	for (const familyId of familyIds) {
		const familyModels = byFamily.get(familyId);
		if (!familyModels) continue;

		for (const model of familyModels) {
			const normalizedName = normalizeModelName(model.name || model.id);
			if (!normalizedName) continue;

			const existingFamilyForName = nameToFamilyId.get(normalizedName);
			if (existingFamilyForName && existingFamilyForName !== familyId) {
				// Same model name found in different family - merge them
				const targetFamily = byFamily.get(existingFamilyForName);
				const sourceFamily = byFamily.get(familyId);
				if (targetFamily && sourceFamily) {
					targetFamily.push(...sourceFamily);
					byFamily.delete(familyId);
					break;
				}
			} else {
				nameToFamilyId.set(normalizedName, familyId);
			}
		}
	}

	const families: ModelFamily[] = [];
	for (const [id, familyModels] of byFamily) {
		const firstModel = familyModels[0]!;
		const familyInfo = detectModelFamily(firstModel)!;

		families.push({
			id,
			displayName: familyInfo.familyName,
			models: familyModels.sort(
				(a, b) =>
					a.provider.localeCompare(b.provider) || b.id.localeCompare(a.id),
			),
		});
	}

	return families.sort((a, b) => a.displayName.localeCompare(b.displayName));
}
