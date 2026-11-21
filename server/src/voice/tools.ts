const obj = (properties: Record<string, unknown>, required: string[] = []) => ({ type: 'object', properties, required });

export const VOICE_TOOLS = [
  {
    type: 'function', name: 'send_task',
    description: 'Hand real work to yourself (your full text agent, which has your computer, connected apps, web search, memory and routines). Use it for anything beyond small talk or what you already know: looking things up, doing things, checking email, scheduling. Pass the request in the user\'s words plus any details they gave. Returns at once; the result arrives later as a [work_landed] note.',
    parameters: obj({
      request: { type: 'string', description: 'What to do, self-contained, with every detail the user gave.' },
      already_announced: { type: 'boolean', description: 'True if you already told the user you are on it.' },
    }, ['request']),
  },
  {
    type: 'function', name: 'recall_text_messages',
    description: 'Read the latest messages in your text chat with the user (including results of work you handed off).',
    parameters: obj({ count: { type: 'integer', description: 'How many recent messages, 1-30. Default 10.' } }),
  },
  {
    type: 'function', name: 'search_conversations',
    description: 'Search past messages and call records for a word or phrase.',
    parameters: obj({
      query: { type: 'string' },
      scope: { type: 'string', enum: ['this_chat', 'earlier', 'everything'], description: 'this_chat = current conversation, earlier = your older conversations, everything = all Bots on the team. Default this_chat.' },
    }, ['query']),
  },
  {
    type: 'function', name: 'peek_activity',
    description: 'See what you (your text agent) are doing right now: whether work is running, open tasks, and anything waiting on the user.',
    parameters: obj({}),
  },
  {
    type: 'function', name: 'end_the_call',
    description: 'Hang up. Use when the user says goodbye or asks to end the call. Say a short goodbye first.',
    parameters: obj({}),
  },
];

// A shared room can delegate work without giving participants access to private chat.
export const MEETING_TOOLS = VOICE_TOOLS.filter((tool) => tool.name === 'send_task')
  .map((tool) => ({
    ...tool,
    description: 'How you get things done during the meeting: share your screen, open or look something up, check who on your team should take something, message a teammate, draft, email or schedule. Use it for anything beyond what you can answer from the conversation. Include who asked and enough context to do it. Returns at once; you then do the work.',
  }));
