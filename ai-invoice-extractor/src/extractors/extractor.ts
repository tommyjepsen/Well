import { PROMPTS } from "@/constants"
import { logger } from "@/libs/logger"
import type { AiConfig, AnyString, MistralModelId, OpenAIModelId, PromptId } from "@/types"
import { FileUtils } from "@/utils/file"
import { StringUtils } from "@/utils/string"
import { createMistral } from "@ai-sdk/mistral"
import { createOpenAI } from "@ai-sdk/openai"
import { APICallError, type LanguageModelV1, NoObjectGeneratedError, generateObject } from "ai"
import type { z } from "zod"

// ==============================
// Types
// ==============================

type AnalyseFilePathInput<O = z.ZodSchema> = {
  path: string
  prompt: PromptId | AnyString
  output: z.ZodType<O>
}

// ==============================
// Interfaces
// ==============================

export interface IExtractor {
  analyseFile<O>(props: AnalyseFilePathInput<O>): Promise<O>
}

// ==============================
// Abstract class
// ==============================

export abstract class BaseExtractor implements IExtractor {
  public constructor(protected readonly model: LanguageModelV1) {}

  // Public methods
  // ==============================

  async analyseFile<O>(input: AnalyseFilePathInput<O>): Promise<O> {
    const { path, prompt = "EXTRACT_INVOICE", output } = input

    // Get file data
    // ---------------------------
    const file = FileUtils.getMetadata(path)
    const buffer = await FileUtils.readFile(path)
    const fileUrl = new URL(`data:${file.mimeType};base64,${buffer.toString("base64")}`)

    if (file.fileType !== "image" && file.fileType !== "file") {
      throw new Error("Only image and PDF files are supported.")
    }

    logger.info(`Analyzing ${file.filename}…`)

    // Call LLM
    // ---------------------------
    try {
      const instructions = PROMPTS[prompt as PromptId] || prompt

      logger.debug(`Using instructions: \n${instructions}`)

      const content = [
        file.fileType === "image"
          ? {
              type: "image" as const,
              image: fileUrl,
              mimeType: file.mimeType
            }
          : {
              type: "file" as const,
              data: fileUrl,
              mimeType: file.mimeType,
              filename: file.filename
            }
      ]

      logger.debug(
        `Using content: \n${JSON.stringify(
          content.map(c => ({
            type: c.type,
            mimeType: c.mimeType,
            filename: "filename" in c ? c.filename : undefined,
            image: "image" in c ? StringUtils.mask(c.image?.toString() ?? "", 50) : undefined,
            data: "data" in c ? StringUtils.mask(c.data?.toString() ?? "", 50) : undefined
          }))
        )}\n`
      )

      const { object } = await generateObject({
        model: this.model,
        schema: output,
        system: instructions,
        messages: [{ role: "user", content }]
      })

      return object
    } catch (error) {
      if (APICallError.isInstance(error)) {
        throw new Error(
          `AI_API_CALL_ERROR: ${this.model.provider}:${this.model.modelId} returned: ${error.message.slice(0, 300)}`
        )
      }

      if (NoObjectGeneratedError.isInstance(error)) {
        logger.debug(`[NoObjectGeneratedError] ${this.model.provider}:${this.model.modelId} returned: \n${error.text}`)
        logger.debug(`[NoObjectGeneratedError] ${this.model.provider}:${this.model.modelId} cause: \n${error.cause}`)
        throw new Error(`${this.model.provider}:${this.model.modelId} returned: ${error.message}`)
      }

      throw new Error(`${this.model.provider}:${this.model.modelId} returned: ${(error as Error).message}`)
    }
  }
}

// ==============================
// Implementations
// ==============================

export class MistralExtractor extends BaseExtractor {
  constructor(model: MistralModelId | AnyString, apiKey: string) {
    logger.debug(`Creating extractor mistral:${model} with apiKey: ${StringUtils.mask(apiKey)}`)
    const mistral = createMistral({ apiKey })
    super(mistral(model))
  }
}

export class OpenAIExtractor extends BaseExtractor {
  constructor(model: OpenAIModelId | AnyString, apiKey: string) {
    logger.debug(`Creating extractor openai:${model} with apiKey: ${StringUtils.mask(apiKey)}`)
    const openai = createOpenAI({ apiKey })
    super(openai(model))
  }
}

// ==============================
// Factory (entry point)
// ==============================

export class Extractor {
  static create(config: AiConfig): IExtractor {
    switch (config.vendor) {
      case "openai":
        return new OpenAIExtractor(config.model, config.apiKey)
      case "mistral":
        return new MistralExtractor(config.model, config.apiKey)
      default:
        throw new Error(`Unsupported vendor: ${(config as AiConfig).vendor}`)
    }
  }
}
