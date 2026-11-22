/**
 * Adapter for any OpenAI-compatible Chat Completions endpoint (OpenAI,
 * DeepSeek, vLLM, Ollama, LM Studio, OpenRouter, ...).
 *
 *   openai({ baseURL: 'https://api.deepseek.com/v1', apiKey, model: 'deepseek-chat' })
 *
 * The runtime keeps every hand's transcript append-only and shares the system
 * prompt across hands and dispatch, so providers with automatic prefix caching
 * get cache hits without extra configuration.
 */
export function openai({ baseURL = 'https://api.openai.com/v1', apiKey, model, temperature, extraBody = {}, headers = {}, fetchImpl = fetch } = {}) {
  if (!model) throw new TypeError('model is required');
  const url = baseURL.replace(/\/+$/, '') + '/chat/completions';
  return {
    async complete({ system, messages, tools = [], toolChoice = 'auto', signal }) {
      const body = {
        model,
        messages: [{ role: 'system', content: system }, ...messages],
        ...(tools.length && {
          tools: tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.parameters } })),
          tool_choice: typeof toolChoice === 'object' ? { type: 'function', function: { name: toolChoice.name } } : toolChoice,
        }),
        ...(temperature != null && { temperature }),
        ...extraBody,
      };
      const res = await fetchImpl(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(apiKey && { authorization: `Bearer ${apiKey}` }), ...headers },
        body: JSON.stringify(body),
        signal,
      });
      if (!res.ok) {
        const detail = await res.text().catch(() => '');
        const error = new Error(`model request failed: ${res.status} ${detail.slice(0, 300)}`);
        error.status = res.status;
        throw error;
      }
      const data = await res.json();
      const msg = data.choices?.[0]?.message ?? {};
      return {
        text: msg.content ?? '',
        calls: (msg.tool_calls ?? []).map((c) => ({ id: c.id, name: c.function?.name, arguments: c.function?.arguments ?? '{}' })),
        usage: {
          input: data.usage?.prompt_tokens ?? 0,
          cached: data.usage?.prompt_tokens_details?.cached_tokens ?? data.usage?.prompt_cache_hit_tokens ?? 0,
          output: data.usage?.completion_tokens ?? 0,
        },
      };
    },
  };
}
