const TEMPLATE_VARIABLE_PATTERN = /\{\{([a-zA-Z0-9_]+)\}\}/g;

/**
 * Minimal string-template renderer for generated HTML documents.
 */
export class HtmlTemplateRenderer {
  constructor(private readonly template: string) {}

  render(values: Record<string, string>): string {
    return this.template.replace(TEMPLATE_VARIABLE_PATTERN, (_match, key: string) => values[key] ?? "");
  }
}
