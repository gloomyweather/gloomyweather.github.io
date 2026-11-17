/* единый контракт параметров. читают engine.js, presets.js, ui.js, viz.js. не менять id без согласования.
   все слайдеры нормализованы 0..1 (шаг 0.01). select хранит целочисленный индекс в options.
   rare: true — слой «на любителя»: при рандоме чаще всего остаётся на 0. */
window.AMBIENT_SCHEMA = {
  groups: [
    { id: 'tone',  label: 'тон' },
    { id: 'pad',   label: 'пэд' },
    { id: 'notes', label: 'ноты' },
    { id: 'noise', label: 'шум' },
    { id: 'space', label: 'пространство' },
    { id: 'char',  label: 'характер' }
  ],
  params: [
    // тон: общая гармония для пэда, нот и баса
    { id: 'root',  group: 'tone', type: 'select', label: 'тоника', def: 2,
      options: ['c', 'c#', 'd', 'd#', 'e', 'f', 'f#', 'g', 'g#', 'a', 'a#', 'b'] },
    { id: 'scale', group: 'tone', type: 'select', label: 'лад', def: 0,
      options: ['мажорная пентатоника', 'минорная пентатоника', 'лидийский', 'дорийский', 'эолийский', 'фригийский'] },
    { id: 'drift', group: 'tone', type: 'slider', label: 'дрейф', def: 0.4,
      hint: 'как часто сменяются аккорды и плывут тембры: 0 — статично, 1 — постоянно меняется' },

    // пэд: тянущийся аккорд из нескольких расстроенных голосов
    { id: 'padLevel',   group: 'pad', type: 'slider', label: 'громкость', def: 0.6 },
    { id: 'padTone',    group: 'pad', type: 'slider', label: 'тембр',     def: 0.4, hint: 'морфинг волны: 0 — чистый, почти синус/флейта; 0.5 — тёплые струнные; 1 — плотный, органно-стеклянный с верхними гармониками' },
    { id: 'padBright',  group: 'pad', type: 'slider', label: 'яркость',   def: 0.4, hint: 'срез фильтра: 0 — глухо, 1 — открыто' },
    { id: 'padMotion',  group: 'pad', type: 'slider', label: 'движение',  def: 0.4, hint: 'глубина медленной модуляции фильтра и громкости голосов' },
    { id: 'padWidth',   group: 'pad', type: 'slider', label: 'ширина',    def: 0.5, hint: 'расстройка голосов и стерео' },
    { id: 'padShimmer', group: 'pad', type: 'slider', label: 'мерцание',  def: 0.15, hint: 'воздушный слой октавой-двумя выше аккорда, медленно вспыхивает и гаснет' },
    { id: 'subLevel',   group: 'pad', type: 'slider', label: 'бас',       def: 0.3, hint: 'синусоидальный суб на тонике' },

    // ноты: редкие генеративные ноты в ладу
    { id: 'notesLevel',   group: 'notes', type: 'slider', label: 'громкость', def: 0.35 },
    { id: 'notesTone',    group: 'notes', type: 'slider', label: 'тембр',     def: 0.5, hint: 'морфинг инструмента: 0 — мягкий деревянный щипок/маримба; 0.35 — электропиано; 0.6 — колокольчик; 1 — стекло и металл' },
    { id: 'notesDensity', group: 'notes', type: 'slider', label: 'плотность', def: 0.3, hint: '0 — одна нота раз в ~20 с, 1 — несколько в секунду' },
    { id: 'notesDecay',   group: 'notes', type: 'slider', label: 'длина',     def: 0.5, hint: 'затухание: 0 — короткий щипок, 1 — долгий звон' },
    { id: 'notesHeight',  group: 'notes', type: 'slider', label: 'высота',    def: 0.5, hint: 'регистр: 0 — низко, 1 — высоко' },
    { id: 'notesPhrase',  group: 'notes', type: 'slider', label: 'фразы',     def: 0.2, hint: '0 — отдельные случайные ноты; 1 — ноты собираются в короткие мелодические фразы и арпеджио с паузами между ними' },

    // шум: природные текстуры
    { id: 'noiseLevel', group: 'noise', type: 'slider', label: 'громкость', def: 0.25 },
    { id: 'noiseColor', group: 'noise', type: 'slider', label: 'окраска',   def: 0.4, hint: '0 — низкий гул, 0.5 — ветер, 1 — светлое шипение' },
    { id: 'noiseWaves', group: 'noise', type: 'slider', label: 'волны',     def: 0.3, hint: '0 — ровный шум, 1 — медленные накаты как прибой' },
    { id: 'noiseGrain', group: 'noise', type: 'slider', label: 'зерно',     def: 0.0, hint: 'редкое мягкое потрескивание поверх шума: винил, костёр вдалеке' },
    { id: 'rainLevel',  group: 'noise', type: 'slider', label: 'дождь',     def: 0.0, rare: true, hint: 'отдельный слой капель' },

    // пространство
    { id: 'reverb',     group: 'space', type: 'slider', label: 'реверб', def: 0.6, hint: 'доля обработанного сигнала' },
    { id: 'reverbSize', group: 'space', type: 'slider', label: 'размер', def: 0.6, hint: 'длина хвоста: 0 — комната ~1.5 с, 1 — собор ~12 с' },
    { id: 'delay',      group: 'space', type: 'slider', label: 'эхо',    def: 0.25, hint: 'стерео-дилей с обратной связью, в основном для нот' },

    // характер: обработка всего микса и слой для наушников
    { id: 'tape',     group: 'char', type: 'slider', label: 'плёнка',  def: 0.15, hint: 'плавание высоты как у старой кассеты (медленный wow + лёгкий flutter)' },
    { id: 'warmth',   group: 'char', type: 'slider', label: 'тепло',   def: 0.2,  hint: 'мягкое ламповое насыщение и скруглённый верх' },
    { id: 'binaural', group: 'char', type: 'slider', label: 'биения',  def: 0.0, rare: true, hint: 'бинауральные биения, слышны только в наушниках: два тихих тона с небольшой разницей частот в левом и правом ухе' },
    { id: 'beatRate', group: 'char', type: 'slider', label: 'частота биений', def: 0.3, hint: '0 — 1 гц (глубокий сон), 0.3 — ~4 гц (дремота, медитация), 0.6 — ~9 гц (спокойное внимание), 1 — 16 гц (фокус)' },

    // вне групп, показывается в шапке
    { id: 'volume', group: null, type: 'slider', label: 'громкость', def: 0.7 }
  ]
};
