import { useId } from 'react';
import type { AvatarColor, AvatarShape, Bot } from '@shared/types';
import { palette } from '../lib/colors';
import { Icon } from '../components/Icon';
import { SHAPES, type ShapeDef } from './shapes.gen';

/** Shapes without an exported SVG fall back to the closest silhouette we have. */
const FALLBACK: Partial<Record<AvatarShape, string>> = {
  bean: 'teardrop', squircle: 'square', capsule: 'tablet', cylinder: 'tablet', gem: 'hex', crystal: 'hex',
  shield: 'house', dome: 'house', arch: 'house', leaf: 'teardrop',
};

export function shapeDef(shape: AvatarShape | string): ShapeDef {
  return SHAPES[shape] ?? SHAPES[FALLBACK[shape as AvatarShape] ?? 'blob'] ?? SHAPES.blob;
}

/** Shapes offered in the Create New Bot picker, in the design's order (rows of 5/5/3). */
export const PICKER_SHAPES: AvatarShape[] = ['blob', 'cloud', 'square', 'sparkle', 'clover', 'heart', 'flower', 'teardrop', 'tablet', 'wedge', 'house', 'star', 'hex'];

interface Props {
  shape: AvatarShape | string;
  color: AvatarColor | string;
  /** Slot size in px. The drawing overflows the slot by the design's 1.533x ratio. */
  size: number;
  star?: boolean;
  /** Selected-shape ring (white gap + gray outline following the silhouette). */
  ring?: boolean;
  className?: string;
  title?: string;
  /** Soft lighting for a larger, floating avatar: a top-left highlight and a faint lower shade on the shape itself. */
  depth?: boolean;
}

const OVERDRAW = 55.2 / 36;

export function BotAvatar({ shape, color, size, star, ring, className, title, depth }: Props) {
  const lightId = `bot-light-${useId().replace(/[^a-zA-Z0-9_-]/g, '')}`;
  const def = shapeDef(shape);
  const draw = size * OVERDRAW;
  const off = (draw - size) / 2;
  const fill = palette(color).fill;
  // Stroke widths in viewBox units: viewBox width maps to `draw` px.
  const vbw = Number(def.viewBox.split(/\s+/)[2]);
  const px = vbw / draw;
  return (
    <span className={`bot-avatar ${className ?? ''}`} style={{ width: size, height: size }} title={title} role="img" aria-label={title}>
      <svg width={draw} height={draw} viewBox={def.viewBox} style={{ position: 'absolute', left: -off, top: -off, overflow: 'visible' }} aria-hidden>
        {ring && <path d={def.outline} fill="#1C1C1C3D" stroke="#1C1C1C3D" strokeWidth={px * 2 * 3.4} strokeLinejoin="round" />}
        {ring && <path d={def.outline} fill="#FFFFFF" stroke="#FFFFFF" strokeWidth={px * 2 * 2.4} strokeLinejoin="round" />}
        <path d={def.outline} fill="#FFFFFF" />
        <path d={def.d} fill={fill} fillRule="evenodd" />
        {depth && (
          <>
            <defs>
              <radialGradient id={lightId} cx="32%" cy="26%" r="78%">
                <stop offset="0%" stopColor="#FFFFFF" stopOpacity="0.34" />
                <stop offset="45%" stopColor="#FFFFFF" stopOpacity="0.06" />
                <stop offset="78%" stopColor="#000000" stopOpacity="0" />
                <stop offset="100%" stopColor="#000000" stopOpacity="0.22" />
              </radialGradient>
            </defs>
            <path d={def.d} fill={`url(#${lightId})`} fillRule="evenodd" />
          </>
        )}
      </svg>
      {star && (
        <span className="bot-avatar__star" style={{ width: size * 0.2667, height: size * 0.2667 }}>
          <Icon name="star" size={size * 0.1333} color="#FFFFFF" />
        </span>
      )}
    </span>
  );
}

export function BotAvatarFor({ bot, size, star, className, depth }: { bot: Pick<Bot, 'avatarShape' | 'avatarColor' | 'name'> & { isPrimary?: boolean }; size: number; star?: boolean; className?: string; depth?: boolean }) {
  return <BotAvatar shape={bot.avatarShape} color={bot.avatarColor} size={size} star={star} className={className} title={bot.name} depth={depth} />;
}
