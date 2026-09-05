import type { ModelInput } from './model-events.js';

export type VisionMediaType = 'image/png' | 'image/jpeg';

export interface ModelImage {
  mediaType: VisionMediaType;
  bytes: Buffer;
}

function dataUrl(image: ModelImage): string {
  return `data:${image.mediaType};base64,${image.bytes.toString('base64')}`;
}

export function openaiChatMessages(messages: ModelInput['messages']) {
  return messages.map((message) =>
    message.images?.length
      ? {
          role: message.role,
          content: [
            { type: 'text', text: message.content },
            ...message.images.map((image) => ({
              type: 'image_url',
              image_url: { url: dataUrl(image) },
            })),
          ],
        }
      : { role: message.role, content: message.content },
  );
}

export function openaiResponsesInput(messages: ModelInput['messages']) {
  return messages.map((message) =>
    message.images?.length
      ? {
          role: message.role,
          content: [
            { type: 'input_text', text: message.content },
            ...message.images.map((image) => ({
              type: 'input_image',
              image_url: dataUrl(image),
            })),
          ],
        }
      : { role: message.role, content: message.content },
  );
}

export function anthropicMessages(messages: ModelInput['messages']) {
  return messages
    .filter((message) => message.role !== 'system')
    .map((message) =>
      message.images?.length
        ? {
            role: message.role,
            content: [
              { type: 'text', text: message.content },
              ...message.images.map((image) => ({
                type: 'image',
                source: {
                  type: 'base64',
                  media_type: image.mediaType,
                  data: image.bytes.toString('base64'),
                },
              })),
            ],
          }
        : { role: message.role, content: message.content },
    );
}
