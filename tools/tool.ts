// Minimal typing of the v2 Promise tool contract used by this plugin.
export type ToolContext = { sessionID: string; agent: string; messageID?: string; id?: string }
export type ToolResult = { content: string; metadata?: Record<string, unknown> }
export type JsonSchema = Record<string, unknown>
export type ToolInfo<Input = any> = {
  name: string
  description: string
  input: JsonSchema
  execute: (input: Input, context: ToolContext) => Promise<ToolResult>
}
