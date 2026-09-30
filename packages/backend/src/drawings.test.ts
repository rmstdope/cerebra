import type { AgentEvent } from '@cerebra/shared';
import { describe, expect, it } from 'vitest';

import {
  createDrawingQuestions,
  DrawingsAnswerError,
  type DrawingQuestions,
} from './drawings.js';

const runId = '11111111-1111-4111-8111-111111111111';

const round = {
  question: 'Where should the export live?',
  drawings: [
    {
      label: 'A · Button in the toolbar',
      cost: 'One click; the toolbar gets busier',
      recommended: true,
      mockupId: 'mockup-a',
    },
    {
      label: 'B · Inside the ⋯ menu',
      cost: 'Tidy toolbar; one extra click',
      recommended: false,
      mockupId: null,
    },
  ],
};

function setup(): {
  drawings: DrawingQuestions;
  notes: Array<[string, AgentEvent, string]>;
} {
  const notes: Array<[string, AgentEvent, string]> = [];
  const drawings = createDrawingQuestions({
    note: async (run, event, state) => {
      notes.push([run, event, state]);
    },
  });
  return { drawings, notes };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

function askedId(notes: Array<[string, AgentEvent, string]>, at = 0): string {
  const event = notes.filter(([, event]) => event.kind === 'drawings')[at]?.[1];
  if (event?.kind !== 'drawings') throw new Error('No round was asked.');
  return event.drawingsId;
}

describe('drawing questions', () => {
  it('keeps the round waiting when its answer could not be written', async () => {
    const notes: Array<[string, AgentEvent, string]> = [];
    let failNext = true;
    const drawings = createDrawingQuestions({
      note: async (run, event, state) => {
        if (event.kind === 'drawings_answer' && failNext) {
          failNext = false;
          throw new Error('The database went away.');
        }
        notes.push([run, event, state]);
      },
    });
    let resolved = false;
    const answered = drawings.ask(runId, round).then((answer) => {
      resolved = true;
      return answer;
    });
    await settle();
    const drawingsId = askedId(notes);

    await expect(
      drawings.answer(runId, { drawingsId, text: 'Bigger buttons.' }),
    ).rejects.toThrow('The database went away.');
    await settle();
    expect(resolved).toBe(false);

    await drawings.answer(runId, { drawingsId, text: 'Bigger buttons.' });
    await expect(answered).resolves.toEqual({
      choice: null,
      text: 'Bigger buttons.',
    });
  });

  it('asks a round and resolves with the chosen label', async () => {
    const { drawings, notes } = setup();
    const answered = drawings.ask(runId, round);
    await settle();
    const drawingsId = askedId(notes);
    expect(notes).toEqual([
      [runId, { kind: 'drawings', drawingsId, ...round }, 'awaiting_input'],
    ]);

    await expect(
      drawings.answer(runId, {
        choice: 'A · Button in the toolbar',
        drawingsId,
      }),
    ).resolves.toEqual({ choice: 'A · Button in the toolbar', text: '' });
    await expect(answered).resolves.toEqual({
      choice: 'A · Button in the toolbar',
      text: '',
    });
    expect(notes.at(-1)).toEqual([
      runId,
      {
        choice: 'A · Button in the toolbar',
        drawingsId,
        kind: 'drawings_answer',
        text: '',
      },
      'active',
    ]);
  });

  it('resolves with a written change', async () => {
    const { drawings, notes } = setup();
    const answered = drawings.ask(runId, round);
    await settle();
    const drawingsId = askedId(notes);

    await drawings.answer(runId, {
      drawingsId,
      text: '  Make the button smaller.  ',
    });
    await expect(answered).resolves.toEqual({
      choice: null,
      text: 'Make the button smaller.',
    });
  });

  it('refuses a label not in the round and an empty change', async () => {
    const { drawings, notes } = setup();
    void drawings.ask(runId, round);
    await settle();
    const drawingsId = askedId(notes);

    for (const input of [
      { choice: 'C · Nowhere', drawingsId },
      { drawingsId, text: '   ' },
      { drawingsId },
      { choice: 'A · Button in the toolbar', drawingsId, text: 'Also' },
      null,
    ]) {
      await expect(drawings.answer(runId, input)).rejects.toMatchObject({
        code: 'invalid',
      });
    }
    expect(notes).toHaveLength(1);
  });

  it('refuses a round that is not waiting', async () => {
    const { drawings, notes } = setup();
    await expect(
      drawings.answer(runId, {
        choice: 'A · Button in the toolbar',
        drawingsId: 'gone',
      }),
    ).rejects.toBeInstanceOf(DrawingsAnswerError);

    void drawings.ask(runId, round);
    await settle();
    const drawingsId = askedId(notes);
    await drawings.answer(runId, { drawingsId, text: 'Smaller.' });
    await expect(
      drawings.answer(runId, { drawingsId, text: 'Again.' }),
    ).rejects.toMatchObject({ code: 'not_waiting' });
    await expect(
      drawings.answer('22222222-2222-4222-8222-222222222222', {
        drawingsId,
        text: 'Elsewhere.',
      }),
    ).rejects.toMatchObject({ code: 'not_waiting' });
  });

  it('a newer round withdraws the older', async () => {
    const { drawings, notes } = setup();
    const first = drawings.ask(runId, round);
    const refused = expect(first).rejects.toThrow('A newer round');
    await settle();
    const older = askedId(notes);
    void drawings.ask(runId, { ...round, question: 'Which of these?' });
    await settle();
    const newer = askedId(notes, 1);

    await refused;
    expect(notes.map(([, event]) => event.kind)).toEqual([
      'drawings',
      'drawings_withdrawn',
      'drawings',
    ]);
    expect(notes[1]).toEqual([
      runId,
      { drawingsId: older, kind: 'drawings_withdrawn' },
      'active',
    ]);
    await expect(
      drawings.answer(runId, { drawingsId: older, text: 'Late.' }),
    ).rejects.toMatchObject({ code: 'not_waiting' });
    await expect(
      drawings.answer(runId, { drawingsId: newer, text: 'Now.' }),
    ).resolves.toEqual({ choice: null, text: 'Now.' });
  });

  it('an abandoned ask is withdrawn', async () => {
    const { drawings, notes } = setup();
    const controller = new AbortController();
    const asked = drawings.ask(runId, round, controller.signal);
    await settle();
    const drawingsId = askedId(notes);

    controller.abort(new Error('The turn ended.'));
    await expect(asked).rejects.toThrow('The turn ended.');
    await settle();
    expect(notes.at(-1)).toEqual([
      runId,
      { drawingsId, kind: 'drawings_withdrawn' },
      'active',
    ]);
    await expect(
      drawings.answer(runId, { drawingsId, text: 'Late.' }),
    ).rejects.toMatchObject({ code: 'not_waiting' });
  });

  it('refuses a round with no drawings or a repeated label', async () => {
    const { drawings, notes } = setup();
    await expect(
      drawings.ask(runId, { ...round, drawings: [] }),
    ).rejects.toThrow();
    await expect(
      drawings.ask(runId, {
        ...round,
        drawings: [round.drawings[0]!, round.drawings[0]!],
      }),
    ).rejects.toThrow();
    expect(notes).toEqual([]);
  });

  describe('a set on its way', () => {
    const preparing = { question: round.question, count: 2 };

    it('prepares a round, then shows it under the same id and waits', async () => {
      const { drawings, notes } = setup();
      const prepared = await drawings.prepare(runId, preparing);
      expect(notes).toEqual([
        [
          runId,
          {
            count: 2,
            drawingsId: prepared.drawingsId,
            kind: 'drawings_preparing',
            question: round.question,
          },
          'active',
        ],
      ]);

      const answered = prepared.show(round.drawings);
      await settle();
      expect(notes[1]).toEqual([
        runId,
        { kind: 'drawings', drawingsId: prepared.drawingsId, ...round },
        'awaiting_input',
      ]);
      await drawings.answer(runId, {
        choice: 'B · Inside the ⋯ menu',
        drawingsId: prepared.drawingsId,
      });
      await expect(answered).resolves.toEqual({
        choice: 'B · Inside the ⋯ menu',
        text: '',
      });
    });

    it('a withdrawn preparing round shows nothing more', async () => {
      const { drawings, notes } = setup();
      const prepared = await drawings.prepare(runId, preparing);
      await prepared.withdraw();

      expect(notes.map(([, event, state]) => [event.kind, state])).toEqual([
        ['drawings_preparing', 'active'],
        ['drawings_withdrawn', 'active'],
      ]);
      expect(notes[1]?.[1]).toEqual({
        drawingsId: prepared.drawingsId,
        kind: 'drawings_withdrawn',
      });
      await expect(prepared.show(round.drawings)).rejects.toThrow();
      await expect(
        drawings.answer(runId, {
          drawingsId: prepared.drawingsId,
          text: 'Late.',
        }),
      ).rejects.toMatchObject({ code: 'not_waiting' });
      expect(notes).toHaveLength(2);
    });

    it('a set of another size than prepared is refused', async () => {
      const { drawings, notes } = setup();
      const prepared = await drawings.prepare(runId, {
        ...preparing,
        count: 3,
      });
      await expect(prepared.show(round.drawings)).rejects.toThrow(
        'The set holds 2 drawings, not the 3 prepared.',
      );
      // A set that could not be shown is not left on its way.
      expect(notes.map(([, event]) => event.kind)).toEqual([
        'drawings_preparing',
        'drawings_withdrawn',
      ]);
    });

    it('a set abandoned while on its way is withdrawn at once', async () => {
      const { drawings, notes } = setup();
      const abandoned = new AbortController();
      const prepared = await drawings.prepare(
        runId,
        preparing,
        abandoned.signal,
      );
      abandoned.abort();
      await settle();
      expect(notes[1]?.[1]).toEqual({
        drawingsId: prepared.drawingsId,
        kind: 'drawings_withdrawn',
      });
      await expect(prepared.show(round.drawings)).rejects.toThrow();
      expect(notes).toHaveLength(2);
    });

    it('a round started while a set is announced waits for its withdrawal', async () => {
      const notes: Array<[string, AgentEvent, string]> = [];
      let release = () => {};
      const held = new Promise<void>((resolve) => (release = resolve));
      const drawings = createDrawingQuestions({
        note: async (run, event, state) => {
          if (event.kind === 'drawings_preparing' && notes.length === 0) {
            await held;
          }
          notes.push([run, event, state]);
        },
      });
      const first = drawings.prepare(runId, preparing);
      await settle();
      const second = drawings.prepare(runId, preparing);
      await settle();
      release();
      const [older, newer] = await Promise.all([first, second]);

      expect(notes.map(([, event]) => event.kind)).toEqual([
        'drawings_preparing',
        'drawings_withdrawn',
        'drawings_preparing',
      ]);
      expect(notes[1]?.[1]).toMatchObject({ drawingsId: older.drawingsId });
      await expect(older.show(round.drawings)).rejects.toThrow(
        'no longer on its way',
      );
      expect(notes[2]?.[1]).toMatchObject({ drawingsId: newer.drawingsId });
    });

    it('a newer round is shown even when the older set cannot be withdrawn', async () => {
      const notes: Array<[string, AgentEvent, string]> = [];
      const drawings = createDrawingQuestions({
        note: async (run, event, state) => {
          if (event.kind === 'drawings_withdrawn') {
            throw new Error('The database went away.');
          }
          notes.push([run, event, state]);
        },
      });
      await drawings.prepare(runId, preparing);
      const newer = await drawings.prepare(runId, preparing);
      expect(notes.map(([, event]) => event.kind)).toEqual([
        'drawings_preparing',
        'drawings_preparing',
      ]);
      expect(notes[1]?.[1]).toMatchObject({ drawingsId: newer.drawingsId });
    });

    it('a newer round withdraws a set still on its way', async () => {
      const { drawings, notes } = setup();
      const older = await drawings.prepare(runId, preparing);
      const newer = drawings.ask(runId, round);
      await settle();
      expect(notes.map(([, event]) => event.kind)).toEqual([
        'drawings_preparing',
        'drawings_withdrawn',
        'drawings',
      ]);
      expect(notes[1]?.[1]).toMatchObject({ drawingsId: older.drawingsId });
      await drawings.answer(runId, {
        drawingsId: askedId(notes),
        text: 'Fine.',
      });
      await expect(newer).resolves.toMatchObject({ text: 'Fine.' });
    });

    it('preparing replaces an older waiting round', async () => {
      const { drawings, notes } = setup();
      const first = drawings.ask(runId, round);
      const refused = expect(first).rejects.toThrow('A newer round');
      await settle();
      const older = askedId(notes);

      await drawings.prepare(runId, preparing);
      await refused;
      expect(notes.map(([, event]) => event.kind)).toEqual([
        'drawings',
        'drawings_withdrawn',
        'drawings_preparing',
      ]);
      expect(notes[1]?.[1]).toEqual({
        drawingsId: older,
        kind: 'drawings_withdrawn',
      });
    });

    it('an abandoned prepared round is withdrawn', async () => {
      const { drawings, notes } = setup();
      const controller = new AbortController();
      const prepared = await drawings.prepare(
        runId,
        preparing,
        controller.signal,
      );
      const answered = prepared.show(round.drawings);
      await settle();

      controller.abort(new Error('The turn ended.'));
      await expect(answered).rejects.toThrow('The turn ended.');
      await settle();
      expect(notes.at(-1)).toEqual([
        runId,
        { drawingsId: prepared.drawingsId, kind: 'drawings_withdrawn' },
        'active',
      ]);
    });
  });
});
