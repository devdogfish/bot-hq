import { pathToFileURL } from 'node:url';
import { ELEVENLABS_API, ELEVENLABS_DEFAULT_VOICE, elevenlabsLanguage } from '../src/voice/elevenlabs-config.js';
import { LANGUAGES } from '../src/voice/settings.js';
import { VOICE_TOOLS } from '../src/voice/tools.js';

interface WorkspaceTool { id: string; tool_config: { type: string; name: string } }
interface ToolPage { tools: WorkspaceTool[]; has_more: boolean; next_cursor?: string }

export async function syncElevenLabsAgent(apiKey: string, agentId?: string): Promise<string> {
  if (!apiKey) throw new Error('Set ELEVENLABS_API_KEY to sync the agent.');
  async function request<T>(path: string, method = 'GET', body?: unknown): Promise<T> {
    const response = await fetch(`${ELEVENLABS_API}/v1/convai/${path}`, {
      method,
      headers: { 'xi-api-key': apiKey, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) throw new Error(`ElevenLabs ${method} ${path.split('?')[0]} failed (HTTP ${response.status}).`);
    return response.json() as Promise<T>;
  }

  const attached = new Map<string, string>();
  if (agentId) {
    const query = new URLSearchParams({ used_by_agent_id: agentId, types: 'client', page_size: '100' });
    while (true) {
      const page = await request<ToolPage>(`tools?${query}`);
      for (const tool of page.tools) if (tool.tool_config.type === 'client') attached.set(tool.tool_config.name, tool.id);
      if (!page.has_more || !page.next_cursor || page.next_cursor === query.get('cursor')) break;
      query.set('cursor', page.next_cursor);
    }
  }
  const toolIds: string[] = [];
  for (const { name, description, parameters } of VOICE_TOOLS) {
    const toolId = attached.get(name);
    const body = { tool_config: { type: 'client', name, description, parameters, expects_response: true } };
    const tool = await request<WorkspaceTool>(toolId ? `tools/${encodeURIComponent(toolId)}` : 'tools', toolId ? 'PATCH' : 'POST', body);
    toolIds.push(tool.id);
  }

  const languages = new Set(LANGUAGES.map(({ code }) => elevenlabsLanguage(code)));
  languages.delete(undefined);
  languages.delete('en');
  const config = {
    conversation_config: {
      asr: { user_input_audio_format: 'pcm_24000' },
      tts: { voice_id: ELEVENLABS_DEFAULT_VOICE, model_id: 'eleven_v4_turbo', agent_output_audio_format: 'pcm_24000' },
      conversation: {
        client_events: [
          'conversation_initiation_metadata', 'audio', 'interruption', 'client_tool_call', 'user_transcript',
          'agent_response', 'agent_response_correction', 'agent_response_complete', 'client_error', 'ping',
        ],
      },
      agent: {
        language: 'en',
        prompt: {
          tool_ids: toolIds,
          built_in_tools: {
            language_detection: { type: 'system', name: 'language_detection', params: { system_tool_type: 'language_detection' } },
          },
        },
      },
      language_presets: Object.fromEntries([...languages].map((code) => [code, { overrides: {} }])),
    },
    platform_settings: {
      auth: { enable_auth: true },
      overrides: {
        conversation_config_override: {
          agent: { prompt: { prompt: true }, first_message: true, language: true },
          tts: { voice_id: true, speed: true },
        },
      },
    },
  };

  if (agentId) {
    await request(`agents/${encodeURIComponent(agentId)}`, 'PATCH', config);
    return agentId;
  }
  const agent = await request<{ agent_id: string }>('agents/create', 'POST', { name: 'Bot HQ voice', ...config });
  return agent.agent_id;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  syncElevenLabsAgent(process.env.ELEVENLABS_API_KEY ?? '', process.env.ELEVENLABS_AGENT_ID)
    .then((id) => console.log(`ELEVENLABS_AGENT_ID=${id}`))
    .catch((e: Error) => { console.error(e.message); process.exitCode = 1; });
}
