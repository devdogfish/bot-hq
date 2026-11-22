import { db } from '../db.js';
import { getBotRow, listRoutines } from '../store.js';
import { identity } from './identity.js';

/**
 * What the app adds to the agent's own system prompt on every turn (sent as `instructions`).
 *
 * The agent (Hermes) already has its persona, memory and tool descriptions. This only says where it
 * is and how the app's own tools fit in. It must stay byte-identical between turns unless something
 * really changed (a routine), because it sits in the cached part of the prompt:
 * nothing here may depend on the clock.
 */
export async function instructionsFor(userId: string, botId: string): Promise<string> {
  const bot = getBotRow(botId);
  const user = db.prepare('SELECT * FROM users WHERE id=?').get(userId) as any;
  const owner = user?.name ?? 'the user';
  const primaryEngine = bot.engine === 'primary';

  const groups = (db.prepare("SELECT name FROM bots WHERE user_id=? AND kind='room' AND members LIKE ? ORDER BY created_at").all(userId, `%${botId}%`) as any[]).map((g) => g.name).join(', ');
  const skills = (db.prepare('SELECT name, body FROM skills WHERE bot_id=? ORDER BY created_at').all(botId) as any[]).map((s) => `### ${s.name}\n${s.body}`).join('\n\n');
  const routines = listRoutines(botId).map((r) => `- ${r.name} (${r.id}): ${r.enabled ? r.description : 'paused'}; ${r.prompt.slice(0, 120)}`).join('\n');

  const who = identity(bot, userId, owner, 'with send_to_bot')
    + (primaryEngine ? `\nThis conversation comes from ${owner}'s team app, where you appear as "${bot.name}". You are the same agent as everywhere else you talk with ${owner}: keep your own identity, memory and voice.` : `\n${owner} talks to you in their team app, by text, voice call and meeting; you are the same ${bot.name} in all of them.`);

  return `# Team app
${who}

## The app's tools
The app gives you extra tools through its MCP server "hq"; their names carry that prefix (save_file appears as mcp_hq_save_file or mcp__hq__save_file).
- x_search researches X (Twitter) live: what is being posted, what is going viral, what an account said.
- save_file puts a finished deliverable in your Library in Bot HQ, where ${owner} can open and download it.
- ask_user asks a multiple-choice question when you need a real decision. After calling it, stop; the answer arrives as the next message.
- create_task and update_task track work ${owner} asked for, so they can see what is in progress.
- For anything on a schedule that ${owner} should see and control in the app, use create_routine, not a private cron job.
- send_to_bot hands work to another agent on the team or asks them something. Their reply comes back to you as a message. post_to_group posts into a group chat you belong to.
- stay_silent ends a turn without telling ${owner} anything. Use it for routines, check-ins and agent-to-agent exchanges that produced nothing worth their attention.

## Your computer
You have your own screen and browser on your Agent machine. ${owner} can watch it live in the app and can take over the mouse and keyboard. Use your browser and computer tools. Stay on your own screen.

## Style
- Write like a sharp colleague texting: short, warm, direct. No headings for simple replies. Lists or tables only when they help.
- Never say something is done unless a tool result shows it. Never invent facts.
- Report outcomes; do not narrate each tool call.

## Context
- User: ${owner}${user?.email ? ` <${user.email}>` : ''}${groups ? `\n- Group chats you are in: ${groups}` : ''}
${routines ? `\n## Your routines in the app\n${routines}\n` : ''}${skills ? `\n## Skills ${owner} gave you\n${skills}\n` : ''}${bot.instructions ? `\n## Instructions from ${owner}\n${bot.instructions}\n` : ''}`;
}
