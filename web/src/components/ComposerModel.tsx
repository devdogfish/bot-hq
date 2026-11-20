import { useState } from 'react';
import type { Bot } from '@shared/types';
import { saveEngineModels, useProviders } from '../lib/engineModels';
import { Icon } from './Icon';
import { ModelPicker } from './ModelPicker';

/**
 * Model chip in the composer: picks the model this Agent uses in direct chat. Production turns keep the Agent's production
 * model until the Owner promotes the chat model. The provider list loads on first open, not with every chat.
 */
export function ComposerModel({ bot, onError }: { bot: Bot; onError: (message: string) => void }) {
  const [wanted, setWanted] = useState(false);
  const { providers, failed } = useProviders(bot.id, wanted);
  const production = { provider: bot.provider, model: bot.model };
  const chat = { provider: bot.chatProvider, model: bot.chatModel };
  const shown = chat.model ?? production.model;
  const save = (patch: Parameters<typeof saveEngineModels>[1]) =>
    saveEngineModels(bot.id, patch).catch((e: Error) => onError(`Couldn’t change the model: ${e.message || 'the engine did not answer'}`));

  return (
    <span className="composer-model">
      <ModelPicker
        label="Chat model" placement="above" align="right"
        providers={providers ?? []} loading={!providers && !failed}
        value={chat} production={production.model ? production : undefined}
        defaultLabel="Same as production"
        onOpen={() => setWanted(true)}
        onPick={(m) => save({ chatProvider: m.provider, chatModel: m.model })}
        actions={chat.model ? [{ label: 'Set as production model', onSelect: () => save({ provider: chat.provider, model: chat.model, chatProvider: null, chatModel: null }) }] : []}
        trigger={({ toggle, ref, open: _open, ...aria }) => (
          <button ref={ref} type="button" className={`composer__btn composer__draft composer__model${chat.model ? ' is-override' : ''}`} onClick={toggle} title={chat.model ? 'Chat model (differs from production)' : 'Chat model'} {...aria}>
            <span>{shown ?? 'Model'}</span>
            <Icon name="chev_down" size={10} opacity={0.56} />
          </button>
        )}
      />
    </span>
  );
}
