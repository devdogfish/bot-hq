import { Heart, ThumbsDown, ThumbsUp } from 'lucide-react';
import { REACTION_KINDS, type ReactionKind } from '@shared/types';

export { REACTION_KINDS };

/** The six Messages tapbacks, drawn with Lucide where it has the glyph and type where Messages uses text. */
export function TapbackGlyph({ kind, size = 12 }: { kind: ReactionKind; size?: number }) {
  switch (kind) {
    case 'heart': return <Heart size={size} strokeWidth={0} fill="currentColor" aria-hidden />;
    case 'thumbs_up': return <ThumbsUp size={size} strokeWidth={2.25} aria-hidden />;
    case 'thumbs_down': return <ThumbsDown size={size} strokeWidth={2.25} aria-hidden />;
    case 'haha': return <span className="tapback__text is-haha" aria-hidden>HA<br />HA</span>;
    case 'emphasis': return <span className="tapback__text" aria-hidden>!!</span>;
    case 'question': return <span className="tapback__text" aria-hidden>?</span>;
  }
}

export const REACTION_LABEL: Record<ReactionKind, string> = {
  heart: 'Loved', thumbs_up: 'Liked', thumbs_down: 'Disliked', haha: 'Laughed at', emphasis: 'Emphasized', question: 'Questioned',
};

