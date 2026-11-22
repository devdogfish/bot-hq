import { REACTION_EMOJI, REACTION_KINDS, type MessageBody, type ReactionKind } from '@shared/types';

export { REACTION_KINDS };

type Reaction = NonNullable<MessageBody['reaction']>;

/** The six tapbacks, shown as the emoji Messages now uses for them. */
export function TapbackGlyph({ kind }: { kind: ReactionKind }) {
  return <span className="tapback__emoji" aria-hidden>{REACTION_EMOJI[kind]}</span>;
}

export const REACTION_LABEL: Record<ReactionKind, string> = {
  heart: 'Loved', thumbs_up: 'Liked', thumbs_down: 'Disliked', haha: 'Laughed at', emphasis: 'Emphasized', question: 'Questioned',
};

/** What a stored reaction shows: its tapback's emoji, or the Agent's own emoji. */
export const reactionEmoji = (r: Reaction) => (r.kind === 'emoji' ? r.emoji ?? '' : REACTION_EMOJI[r.kind]);
export const reactionLabel = (r: Reaction) => (r.kind === 'emoji' ? `Reacted ${r.emoji ?? ''}` : REACTION_LABEL[r.kind]);
