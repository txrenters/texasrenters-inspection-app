import {
  isInventedLine,
  isLikelySilence,
  withoutInventedSentences,
} from '../src/technician/invented-speech';

describe('lines whisper invents over silence', () => {
  it('recognises the stock endings of subtitled video', () => {
    // From a hallway at a move-out on 2026-11-12 where nobody spoke (names changed).
    expect(isInventedLine('Special thanks to Railway Movers, Jane Doe and John Roe.')).toBe(true);
    expect(isInventedLine('Recorded and edited by Jane Doe and John Roe.')).toBe(true);
    expect(isInventedLine('Thanks for watching.')).toBe(true);
    // And the others whisper is known for.
    expect(isInventedLine('Thank you so much for watching!')).toBe(true);
    expect(isInventedLine('Please subscribe to my channel.')).toBe(true);
    expect(isInventedLine('Don’t forget to subscribe')).toBe(true);
    expect(isInventedLine('Subtitles by the Amara.org community')).toBe(true);
    expect(isInventedLine('See you in the next video.')).toBe(true);
    expect(isInventedLine('Subtítulos realizados por la comunidad de Amara.org')).toBe(true);
    expect(isInventedLine('¡Gracias por ver el video!')).toBe(true);
  });

  it('leaves an inspector’s own words alone', () => {
    for (const line of [
      'The floor is damaged beyond repair.',
      'This was already recorded by the move-in, the scratch by the door.',
      'Thanks, the kitchen is clean and everything is working.',
      'Wall painted by the tenant, the colour does not match.',
      'Subway tile backsplash, two cracked tiles.',
      'El baño está limpio, gracias.',
      'Rest of the room is fine.',
    ])
      expect(isInventedLine(line)).toBe(false);
  });

  it('reads whisper’s own estimate that a stretch held no speech', () => {
    expect(isLikelySilence({ no_speech_prob: 0.82 })).toBe(true);
    expect(isLikelySilence({ no_speech_prob: 0.05 })).toBe(false);
    // A model that gives no estimate says nothing about silence.
    expect(isLikelySilence({})).toBe(false);
    expect(isLikelySilence({ no_speech_prob: null })).toBe(false);
  });

  it('takes the endings out of a transcript without lines, sentence by sentence', () => {
    expect(
      withoutInventedSentences('The sink is leaking. Grout is cracked. Thanks for watching!'),
    ).toBe('The sink is leaking. Grout is cracked.');
    expect(withoutInventedSentences('Thanks for watching.')).toBe('');
    expect(withoutInventedSentences('The sink is leaking.')).toBe('The sink is leaking.');
  });
});
