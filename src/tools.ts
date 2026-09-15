import { defineTool, type ToolDefinition } from '@deepseek-ai/dsh-tools'
import type { AdoptedViewSession, NavigationResult } from './session.ts'

/** Canonical output of `browser_navigate`: where the view ended up. */
const navigationSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    title: { type: 'string', required: true },
    url: { type: 'string', required: true },
  },
} as const

/** Render one navigation result as a single text block. */
function renderNavigation(
  _args: unknown,
  value: NavigationResult,
): { type: 'text'; text: string }[] {
  return [{ type: 'text', text: `${value.title}\n${value.url}` }]
}

/**
 * Build the tools of this plugin.
 *
 * T1 registers exactly one tool. It exists to prove the whole chain —
 * tool call → session → adopted native view — rather than to cover the surface a
 * later ticket will expose.
 *
 * @param adopt - resolves the adopted view session, connecting on first use.
 * @returns the tool definitions to register.
 */
export function desktopViewTools(adopt: () => Promise<AdoptedViewSession>): ToolDefinition[] {
  return [
    defineTool({
      name: 'browser_navigate',
      description:
        'Open a URL in the desktop browser view and return the title and final address of the loaded page.',
      parameters: {
        url: { type: 'string', required: true, description: 'The absolute URL to open' },
      },
      output: { schema: navigationSchema, render: renderNavigation },
      async execute(args): Promise<NavigationResult> {
        const session = await adopt()
        return await session.goto(args.url)
      },
    }),
  ]
}
