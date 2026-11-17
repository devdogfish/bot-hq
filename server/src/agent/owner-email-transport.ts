import { SESv2Client, SESv2ServiceException, SendEmailCommand, type SendEmailCommandOutput } from '@aws-sdk/client-sesv2';
import { ownerEmailContent, ownerEmailRecipients } from './owner-email-policy.js';

export const OWNER_EMAIL_ROLES = Object.freeze(['tyler', 'stacy', 'sam'] as const);

export type OwnerEmailRole = typeof OWNER_EMAIL_ROLES[number];
export interface OwnerEmailPacket {
  role: OwnerEmailRole;
  subject: string;
  body: string;
}

export type OwnerEmailDelivery =
  | { kind: 'accepted'; messageId: string }
  | { kind: 'rejected' }
  | { kind: 'uncertain' };

type SesSender = {
  send(command: SendEmailCommand, options: { abortSignal: AbortSignal }): Promise<Pick<SendEmailCommandOutput, 'MessageId'>>;
};

// A documented SES refusal with its expected status is evidence of non-delivery.
const refusals = new Map([
  ['AccountSuspendedException', 400],
  ['BadRequestException', 400],
  ['LimitExceededException', 400],
  ['MailFromDomainNotVerifiedException', 400],
  ['MessageRejected', 400],
  ['NotFoundException', 404],
  ['SendingPausedException', 400],
  ['TooManyRequestsException', 429],
]);

function configuredCredentials() {
  const accessKeyId = process.env.BOT_HQ_EMAIL_SES_ACCESS_KEY_ID?.trim();
  const secretAccessKey = process.env.BOT_HQ_EMAIL_SES_SECRET_ACCESS_KEY?.trim();
  return accessKeyId && secretAccessKey ? { accessKeyId, secretAccessKey } : undefined;
}

const dnsLabel = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u;

export function ownerEmailEnvelope(role: OwnerEmailRole): { from: string; to: string[] } | undefined {
  if (!OWNER_EMAIL_ROLES.includes(role)) return undefined;
  const domain = process.env.HQ_OWNER_EMAIL_FROM_DOMAIN;
  if (!domain || domain.length > 248 || domain !== domain.trim()) return undefined;
  const labels = domain.split('.');
  const topLevelDomain = labels.at(-1);
  if (labels.length < 2 || !labels.every(label => dnsLabel.test(label)) ||
      !topLevelDomain || !/[a-z]/u.test(topLevelDomain)) return undefined;

  const recipients = process.env.HQ_OWNER_EMAIL_TO;
  if (!recipients) return undefined;
  try {
    const to = ownerEmailRecipients(JSON.parse(recipients));
    if (to) return { from: role + '@' + domain, to };
  } catch {
    return undefined;
  }
}

export function ownerEmailTransportConfigured(): boolean {
  return configuredCredentials() !== undefined && ownerEmailEnvelope(OWNER_EMAIL_ROLES[0]) !== undefined;
}

export async function deliverOwnerEmail(packet: OwnerEmailPacket, sender?: SesSender): Promise<OwnerEmailDelivery> {
  if (!packet) return { kind: 'rejected' };
  const envelope = ownerEmailEnvelope(packet.role);
  if (!envelope) return { kind: 'rejected' };
  const content = ownerEmailContent({ subject: packet.subject, body: packet.body });
  if (!content) return { kind: 'rejected' };

  let client: SESv2Client | undefined;
  if (!sender) {
    const credentials = configuredCredentials();
    if (!credentials) return { kind: 'rejected' };
    try {
      client = new SESv2Client({
        credentials,
        region: 'ca-central-1',
        endpoint: 'https://email.ca-central-1.amazonaws.com',
        ignoreConfiguredEndpointUrls: true,
        useFipsEndpoint: false,
        useDualstackEndpoint: false,
        maxAttempts: 1,
      });
      sender = client;
    } catch {
      return { kind: 'rejected' };
    }
  }

  try {
    const command = new SendEmailCommand({
      FromEmailAddress: envelope.from,
      Destination: { ToAddresses: envelope.to },
      Content: { Simple: {
        Subject: { Charset: 'UTF-8', Data: content.subject },
        Body: { Text: { Charset: 'UTF-8', Data: content.body } },
      } },
      ConfigurationOverrides: { Tracking: { OpenTrackingEnabled: 'DISABLED', ClickTrackingEnabled: 'DISABLED' } },
    });
    const { MessageId } = await sender.send(command, { abortSignal: AbortSignal.timeout(30_000) });
    return typeof MessageId === 'string' && MessageId.trim()
      ? { kind: 'accepted', messageId: MessageId }
      : { kind: 'uncertain' };
  } catch (error) {
    if (error instanceof SESv2ServiceException && error.$metadata.httpStatusCode !== undefined &&
        refusals.get(error.name) === error.$metadata.httpStatusCode) {
      return { kind: 'rejected' };
    }
    return { kind: 'uncertain' };
  } finally {
    client?.destroy();
  }
}
