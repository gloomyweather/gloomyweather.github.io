/* единый контракт параметров. читают engine.js, presets.js, ui.js, viz.js. не менять id без согласования.
   все слайдеры нормализованы 0..1 (шаг 0.01). select хранит целочисленный индекс в options.
   rare: true — слой «на любителя»: при рандоме чаще всего остаётся на 0. */
window.AMBIENT_SCHEMA = {
  groups: [
    { id: 'tone',  label: 'tone' },
    { id: 'pad',   label: 'pad' },
    { id: 'notes', label: 'notes' },
    { id: 'noise', label: 'noise' },
    { id: 'space', label: 'space' },
    { id: 'char',  label: 'character' }
  ],
  params: [
    // тон: общая гармония для пэда, нот и баса
    { id: 'root',  group: 'tone', type: 'select', label: 'root note', def: 2,
      options: ['c', 'c#', 'd', 'd#', 'e', 'f', 'f#', 'g', 'g#', 'a', 'a#', 'b'] },
    { id: 'scale', group: 'tone', type: 'select', label: 'scale', def: 0,
      options: ['major pentatonic', 'minor pentatonic', 'lydian', 'dorian', 'aeolian', 'phrygian'] },
    { id: 'drift', group: 'tone', type: 'slider', label: 'drift', def: 0.4,
      hint: 'how often chords change and timbres drift: 0 — static, 1 — always shifting' },

    // пэд: тянущийся аккорд из нескольких расстроенных голосов
    { id: 'padLevel',   group: 'pad', type: 'slider', label: 'volume', def: 0.6 },
    { id: 'padTone',    group: 'pad', type: 'slider', label: 'tone',      def: 0.4, hint: 'wave morph: 0 — pure, almost a sine/flute; 0.5 — warm strings; 1 — dense, organ-and-glass with upper harmonics' },
    { id: 'padBright',  group: 'pad', type: 'slider', label: 'brightness', def: 0.4, hint: 'filter cutoff: 0 — muffled, 1 — open' },
    { id: 'padMotion',  group: 'pad', type: 'slider', label: 'motion',    def: 0.4, hint: 'depth of the slow modulation of the filter and voice volumes' },
    { id: 'padWidth',   group: 'pad', type: 'slider', label: 'width',     def: 0.5, hint: 'voice detune and stereo spread' },
    { id: 'padShimmer', group: 'pad', type: 'slider', label: 'shimmer',   def: 0.15, hint: 'an airy layer one or two octaves above the chord, slowly flaring and fading' },
    { id: 'subLevel',   group: 'pad', type: 'slider', label: 'bass',      def: 0.3, hint: 'a sine sub on the root note' },

    // ноты: редкие генеративные ноты в ладу
    { id: 'notesLevel',   group: 'notes', type: 'slider', label: 'volume', def: 0.35 },
    { id: 'notesTone',    group: 'notes', type: 'slider', label: 'tone',      def: 0.5, hint: 'instrument morph: 0 — soft wooden pluck/marimba; 0.35 — electric piano; 0.6 — bell; 1 — glass and metal' },
    { id: 'notesDensity', group: 'notes', type: 'slider', label: 'density',   def: 0.3, hint: '0 — one note every ~20 s, 1 — several per second' },
    { id: 'notesDecay',   group: 'notes', type: 'slider', label: 'length',    def: 0.5, hint: 'decay: 0 — short pluck, 1 — long ring' },
    { id: 'notesHeight',  group: 'notes', type: 'slider', label: 'height',    def: 0.5, hint: 'register: 0 — low, 1 — high' },
    { id: 'notesPhrase',  group: 'notes', type: 'slider', label: 'phrases',   def: 0.2, hint: '0 — separate random notes; 1 — notes gather into short melodic phrases and arpeggios with pauses between them' },

    // шум: природные текстуры
    { id: 'noiseLevel', group: 'noise', type: 'slider', label: 'volume', def: 0.25 },
    { id: 'noiseColor', group: 'noise', type: 'slider', label: 'color',     def: 0.4, hint: '0 — low rumble, 0.5 — wind, 1 — bright hiss' },
    { id: 'noiseWaves', group: 'noise', type: 'slider', label: 'waves',     def: 0.3, hint: '0 — even noise, 1 — slow swells like surf' },
    { id: 'noiseGrain', group: 'noise', type: 'slider', label: 'grain',     def: 0.0, hint: 'rare soft crackle over the noise: vinyl, a distant campfire' },
    { id: 'rainLevel',  group: 'noise', type: 'slider', label: 'rain',      def: 0.0, rare: true, hint: 'a separate layer of drops' },

    // пространство
    { id: 'reverb',     group: 'space', type: 'slider', label: 'reverb', def: 0.6, hint: 'share of the processed signal' },
    { id: 'reverbSize', group: 'space', type: 'slider', label: 'size',   def: 0.6, hint: 'tail length: 0 — room ~1.5 s, 1 — cathedral ~12 s' },
    { id: 'delay',      group: 'space', type: 'slider', label: 'echo',    def: 0.25, hint: 'stereo delay with feedback, mostly for the notes' },

    // характер: обработка всего микса и слой для наушников
    { id: 'tape',     group: 'char', type: 'slider', label: 'tape',    def: 0.15, hint: 'pitch wobble like an old cassette (slow wow + light flutter)' },
    { id: 'warmth',   group: 'char', type: 'slider', label: 'warmth',  def: 0.2,  hint: 'soft tube saturation and a rounded top end' },
    { id: 'binaural', group: 'char', type: 'slider', label: 'beats',   def: 0.0, rare: true, hint: 'binaural beats, audible only on headphones: two quiet tones with a slight frequency difference in the left and right ear' },
    { id: 'beatRate', group: 'char', type: 'slider', label: 'beat rate', def: 0.3, hint: 'difference between the ears: 0 — 1 hz, 0.3 — ~4 hz, 0.6 — ~9 hz, 1 — 16 hz. effects on the mind are not well proven' },

    // вне групп, показывается в шапке
    { id: 'volume', group: null, type: 'slider', label: 'volume', def: 0.7 }
  ]
};
