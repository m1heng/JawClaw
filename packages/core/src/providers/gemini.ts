import {
  GoogleGenAI,
  type Content,
  type Part,
  type FunctionDeclaration,
} from "@google/genai";
import type { LLMClient, LLMMessage } from "../llm.js";
import type { ToolDefinition, ToolCall } from "../types.js";

export function createGeminiClient(apiKey: string): LLMClient {
  const ai = new GoogleGenAI({ apiKey });

  return {
    async createCompletion({ model, messages, tools }) {
      const systemMsg = messages.find((m) => m.role === "system");
      const conversationMsgs = messages.filter((m) => m.role !== "system");

      const geminiTools = tools?.length
        ? [{ functionDeclarations: tools.map(toFunctionDecl) }]
        : undefined;

      const contents = toContents(conversationMsgs);

      const response = await ai.models.generateContent({
        model,
        contents,
        config: {
          systemInstruction: systemMsg?.content,
          tools: geminiTools,
        },
      });

      const toolCalls: ToolCall[] =
        response.functionCalls?.map((fc, i) => ({
          id: fc.id ?? `fc_${i}`,
          name: fc.name!,
          arguments: (fc.args ?? {}) as Record<string, unknown>,
        })) ?? [];

      const stopReason = mapGeminiFinishReason(
        response.candidates?.[0]?.finishReason,
      );
      return {
        content: response.text ?? null,
        toolCalls,
        stopReason,
      };
    },
  };
}

function mapGeminiFinishReason(reason: string | undefined): string | undefined {
  switch (reason) {
    case "STOP": return "end_turn";
    case "MAX_TOKENS": return "max_tokens";
    case "SAFETY": return "content_filter";
    default: return reason ?? undefined;
  }
}

function toFunctionDecl(t: ToolDefinition): FunctionDeclaration {
  return {
    name: t.name,
    description: t.description,
    parametersJsonSchema: t.parameters,
  };
}

function toContents(messages: LLMMessage[]): Content[] {
  const contents: Content[] = [];

  for (const msg of messages) {
    if (msg.role === "user") {
      contents.push({ role: "user", parts: [{ text: msg.content }] });
    } else if (msg.role === "assistant") {
      const parts: Part[] = [];
      if (msg.content) parts.push({ text: msg.content });
      if (msg.toolCalls?.length) {
        for (const tc of msg.toolCalls) {
          parts.push({
            functionCall: { id: tc.id, name: tc.name, args: tc.arguments },
          });
        }
      }
      if (parts.length > 0) contents.push({ role: "model", parts });
    } else if (msg.role === "tool") {
      // Merge consecutive tool results into one user Content
      const prev = contents[contents.length - 1];
      const part: Part = {
        functionResponse: {
          id: msg.toolCallId,
          name: "",
          response: { result: msg.content },
        },
      };
      if (prev?.role === "user" && prev.parts?.some((p) => "functionResponse" in p)) {
        prev.parts!.push(part);
      } else {
        contents.push({ role: "user", parts: [part] });
      }
    }
  }

  return contents;
}
