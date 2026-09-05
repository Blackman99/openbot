import { describe, expect, it } from 'vitest';
import {
  anthropicMessages,
  openaiChatMessages,
  openaiResponsesInput,
} from '../../src/providers/vision-messages.js';
import { knowledgePng } from '../helpers/image-bytes.js';

const image = { mediaType: 'image/png' as const, bytes: knowledgePng };
const dataUrl = `data:image/png;base64,${knowledgePng.toString('base64')}`;

describe('IMG-01 vision message encoding', () => {
  it('keeps text-only messages unchanged and encodes images per protocol', () => {
    const messages = [
      { role: 'system' as const, content: 'Rules' },
      { role: 'user' as const, content: 'Describe this', images: [image] },
    ];
    expect(openaiChatMessages(messages)).toEqual([
      { role: 'system', content: 'Rules' },
      {
        role: 'user',
        content: [
          { type: 'text', text: 'Describe this' },
          { type: 'image_url', image_url: { url: dataUrl } },
        ],
      },
    ]);
    expect(openaiResponsesInput(messages)).toEqual([
      { role: 'system', content: 'Rules' },
      {
        role: 'user',
        content: [
          { type: 'input_text', text: 'Describe this' },
          { type: 'input_image', image_url: dataUrl },
        ],
      },
    ]);
    expect(anthropicMessages(messages)).toEqual([
      {
        role: 'user',
        content: [
          { type: 'text', text: 'Describe this' },
          {
            type: 'image',
            source: {
              type: 'base64',
              media_type: 'image/png',
              data: knowledgePng.toString('base64'),
            },
          },
        ],
      },
    ]);
  });
});
