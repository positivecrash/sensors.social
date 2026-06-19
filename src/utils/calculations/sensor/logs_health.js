import { ref } from "vue";
import { IDBworkflow, IDBgetByKey, notifyDBChange } from "../../idb.js";
import { getSensorData } from "../../map/sensors/requests.js";
import { dayISO, enumeratePeriodDates, getPeriodBounds } from "../../date.js";
import { idbschemas } from "@config";

// Проверка датчиков на стабильную работу

/** Sorted log points for health checks — full chart / visible period array. */
function healthCheckLogs(logArr) {
  if (!Array.isArray(logArr) || logArr.length === 0) return [];
  return [...logArr].sort((a, b) => Number(a?.timestamp) - Number(b?.timestamp));
}

// Воздух
/**
 * Проверяет, что значения слишком стабильны (залипли) - std слишком маленькое
 * Это может означать, что датчик застрял на одном значении
 * @param {number[]} values - массив значений PM
 * @param {number} threshold - порог std (слишком маленькое отклонение = проблема)
 * @returns {boolean} - true, если std < threshold (данные слишком стабильны)
 */
export function checkStdDeviation(values, threshold) {
  if (values.length < 3) return false; // слишком мало данных для проверки
  
  // Фильтруем нулевые значения - они не считаются "залипшими"
  const nonZeroValues = values.filter(v => v !== undefined && v !== null && v > 0);
  if (nonZeroValues.length < 3) return false;
  
  const mean = nonZeroValues.reduce((a, b) => a + b, 0) / nonZeroValues.length;
  const variance = nonZeroValues.reduce((a, b) => a + Math.pow(b - mean, 2), 0) / nonZeroValues.length;
  const std = Math.sqrt(variance);
  
  // Проверяем, что std слишком маленькое И среднее значение не нулевое
  // Это означает, что значения "залипли" на одном числе
  return std < threshold && mean > 1;
}

/**
 * Проверяет паттерн постоянных резких скачков значений PM
 * Один скачок (например, 700 -> нормальное значение) - это нормально
 * Но если скачки происходят постоянно (паттерн), это проблема
 * @param {number[]} values
 * @returns {boolean}
 */
export function checkInstantJumps(values) {
  if (!values || values.length < 4) return false; // Нужно минимум 4 точки для паттерна
  
  const ZERO_THRESHOLD = 5;
  const MAX_PHYSICAL_PM = 5000;
  const LARGE_VALUE_THRESHOLD = 100; // Порог для "больших" значений
  const MIN_ABSOLUTE_JUMP = 500; // Минимальный абсолютный скачок для больших значений
  const MIN_PERCENT_JUMP = 0.5; // Минимальный процентный скачок (50%) для больших значений
  const MIN_JUMP_COUNT = 3; // Минимум скачков для паттерна

  // Проверка на постоянно высокие значения (1999, 999)
  const VERY_HIGH_THRESHOLD = 1000;
  const MIN_HIGH_RATIO = 0.7; // Если 70%+ значений очень высокие - это проблема
  let highCount = 0;
  for (const value of values) {
    if (value >= VERY_HIGH_THRESHOLD) {
      highCount++;
    }
  }
  if (highCount / values.length >= MIN_HIGH_RATIO) {
    return true;
  }

  let jumpCount = 0;
  let totalChecks = 0;

  for (let i = 1; i < values.length; i++) {
    const a = values[i - 1];
    const b = values[i];
    
    // Проверка на отрицательные значения
    if (a < 0 || b < 0) return true;
    
    // Проверка на физически невозможные значения
    if (a > MAX_PHYSICAL_PM || b > MAX_PHYSICAL_PM) return true;
    
    // Проверка на скачки от нуля к большому значению или наоборот
    if ((a < ZERO_THRESHOLD && b > 100) || (b < ZERO_THRESHOLD && a > 100)) {
      jumpCount++;
      totalChecks++;
      continue;
    }
    
    // Проверка на очень большие скачки только для больших значений
    // Например: 1000 -> 100, 1999 -> 900
    if (a >= LARGE_VALUE_THRESHOLD || b >= LARGE_VALUE_THRESHOLD) {
      totalChecks++;
      const jump = Math.abs(a - b);
      const maxValue = Math.max(a, b);
      
      // Проверяем абсолютный скачок (например, 1000 -> 100 = 900 единиц)
      if (jump >= MIN_ABSOLUTE_JUMP) {
        // Проверяем процентный скачок (например, 1000 -> 100 = 90% падение)
        const percentJump = jump / maxValue;
        if (percentJump >= MIN_PERCENT_JUMP) {
          jumpCount++;
        }
      }
    }
  }

  // Если было достаточно проверок и много скачков - это паттерн проблемы
  // Например, если из 5 проверок 3+ были большими скачками
  if (totalChecks >= 3 && jumpCount >= MIN_JUMP_COUNT) {
    // Проверяем процент скачков от общего числа проверок
    const jumpRatio = jumpCount / totalChecks;
    // Если больше 60% проверок показали большие скачки - это проблема
    if (jumpRatio >= 0.6) {
      return true;
    }
  }

  return false;
}

/**
 * Проверяет, что отношение PM2.5/PM10 слишком низкое (<0.05) в большинстве часов
 * Учитывает, что в некоторых условиях это может быть нормально
 */
export function checkLowRatio(pm25Values, pm10Values) {
  const hours = pm25Values.length;
  if (hours < 3) return false; // Нужно минимум 3 часа для проверки
  
  let count = 0;
  let validPairs = 0;
  
  for (let i = 0; i < hours; i++) {
    if (pm10Values[i] > 0 && pm25Values[i] !== undefined && pm25Values[i] !== null) {
      validPairs++;
      const ratio = pm25Values[i] / pm10Values[i];
      if (ratio < 0.05) count++;
    }
  }
  
  if (validPairs < 3) return false;
  
  // Требуем 90%+ случаев с низким ratio - более строгая проверка
  // И только если PM10 достаточно высокий (не нулевой шум)
  const avgPM10 = pm10Values.filter(v => v > 0).reduce((a, b) => a + b, 0) / pm10Values.filter(v => v > 0).length;
  if (avgPM10 < 5) return false; // Если PM10 в среднем очень низкий, ratio может быть низким естественно
  
  return count / validPairs > 0.9;
}

/**
 * Проверяет невозможную ситуацию, когда PM2.5 > PM10
 * Учитывает погрешность измерений - небольшие отклонения нормальны
 */
export function checkImpossiblePM(pm25Values, pm10Values) {
  const len = pm25Values.length;
  if (len < 3) return false; // Нужно минимум 3 измерения
  
  const ERROR_MARGIN = 5; // Погрешность измерений (5 единиц)
  let count = 0;
  let validPairs = 0;
  
  for (let i = 0; i < len; i++) {
    if (pm25Values[i] !== undefined && pm25Values[i] !== null && 
        pm10Values[i] !== undefined && pm10Values[i] !== null) {
      validPairs++;
      // Учитываем погрешность - если PM2.5 больше PM10 более чем на погрешность
      if (pm25Values[i] > pm10Values[i] + ERROR_MARGIN) {
        count++;
      }
    }
  }
  
  if (validPairs < 3) return false;
  
  // Требуем 20%+ случаев - более строгая проверка
  return count / validPairs > 0.2;
}

/**
 * Проверяет, что PM2.5 почти всегда = 0 (залип на нуле)
 * Учитывает, что в чистом воздухе это может быть нормально
 * @param {number[]} pm25Values
 * @returns {boolean}
 */
export function checkAlwaysZeroPM25(pm25Values) {
  const MIN_HOURS = 10;
  const THRESHOLD = 0.9; // Требуем 90%+ - более строгая проверка

  if (pm25Values.length < MIN_HOURS) return false;

  let zeroCount = 0;
  let totalCount = 0;
  
  for (let v of pm25Values) {
    if (v !== undefined && v !== null) {
      totalCount++;
      if (v < 1) zeroCount++;
    }
  }
  
  if (totalCount < MIN_HOURS) return false;
  
  // Проверяем, что PM2.5 действительно залип на нуле
  // Если есть хотя бы несколько ненулевых значений, это нормально
  const nonZeroCount = totalCount - zeroCount;
  if (nonZeroCount >= 2) return false; // Если есть хотя бы 2 ненулевых значения, это не залип
  
  return zeroCount / totalCount >= THRESHOLD;
}

/**
 * Проверяет, что PM10 почти всегда = 0 (залип на нуле / занижен)
 * @param {number[]} pm10Values
 * @returns {boolean}
 */
export function checkAlwaysZeroPM10(pm10Values) {
  const MIN_HOURS = 10;
  const THRESHOLD = 0.9;

  if (pm10Values.length < MIN_HOURS) return false;

  let zeroCount = 0;
  let totalCount = 0;

  for (const v of pm10Values) {
    if (v !== undefined && v !== null) {
      totalCount++;
      if (v < 1) zeroCount++;
    }
  }

  if (totalCount < MIN_HOURS) return false;

  const nonZeroCount = totalCount - zeroCount;
  if (nonZeroCount >= 2) return false;

  return zeroCount / totalCount >= THRESHOLD;
}

/**
 * Проверяет, что шум (avg/max) почти всегда = 0 (канал "залип" на нуле / сломан).
 * В отличие от PM, для шума постоянный ноль практически не реалистичен.
 * @param {Array} logArr - массив логов
 * @returns {boolean}
 */
export function checkAlwaysZeroNoise(logArr) {
  const MIN_POINTS = 24; // примерно сутки почасовых / чаще данных
  const THRESHOLD = 0.95; // 95%+ нулей
  if (!Array.isArray(logArr) || logArr.length < MIN_POINTS) return false;

  // Берём все точки видимого периода (день / неделя / месяц на графике)
  const windowLogs = healthCheckLogs(logArr);
  if (windowLogs.length < MIN_POINTS) return false;

  let total = 0;
  let zeros = 0;
  let nonZero = 0;

  for (const log of windowLogs) {
    const a = log?.data?.noiseavg;
    const b = log?.data?.noisemax;
    // Используем любое доступное значение, предпочитая avg.
    const vRaw = a ?? b;
    const v = Number(vRaw);
    if (!Number.isFinite(v)) continue;
    total++;
    if (v === 0) zeros++;
    else if (v > 0) nonZero++;
  }

  if (total < MIN_POINTS) return false;
  // Если есть хотя бы несколько ненулевых значений — это не "залипание на нуле"
  if (nonZero >= 2) return false;
  return zeros / total >= THRESHOLD;
}


/**
 * Проверяет стабильность PM за видимый на графике период
 * @param {Array} logArr - массив логов с timestamp и data
 * @returns {Object} - результаты всех проверок
 */
export function checkStability(logArr) {
  if (!logArr || logArr.length < 2) return {};

  const logs = healthCheckLogs(logArr);
  const pm25Values = logs.map((d) => d.data.pm25);
  const pm10Values = logs.map((d) => d.data.pm10);

  const stableStdPM25 = checkStdDeviation(pm25Values, 0.3);
  const stableStdPM10 = checkStdDeviation(pm10Values, 0.5);

  return {
    // Залипание хотя бы одного канала — подозрительно (раньше требовались оба)
    stableStd: stableStdPM25 || stableStdPM10,
    stableStdPM25,
    stableStdPM10,
    instantJumps: checkInstantJumps(pm25Values) || checkInstantJumps(pm10Values),
    lowRatio: checkLowRatio(pm25Values, pm10Values),
    impossiblePM: checkImpossiblePM(pm25Values, pm10Values),
    alwaysZeroPM25: checkAlwaysZeroPM25(pm25Values),
    alwaysZeroPM10: checkAlwaysZeroPM10(pm10Values),
  };
}

// Температура и влажность
/**
 * Проверяет, что RH = 100% больше 8 часов подряд
 * @param {Array} logArr - массив логов с timestamp и data
 * @returns {boolean}
 */
export function checkRH100ForTooLong(logArr) {
  const EIGHT_HOURS = 8 * 3600; // секунды
  if (!logArr || logArr.length < 2) return false;

  const sortedLogs = [...logArr].sort((a, b) => a.timestamp - b.timestamp);
  
  let consecutive100Start = null;
  let consecutive100End = null;

  for (let i = 0; i < sortedLogs.length; i++) {
    const log = sortedLogs[i];
    const rh = log?.data?.humidity;
    
    if (rh !== undefined && rh !== null && rh >= 100) {
      if (consecutive100Start === null) {
        consecutive100Start = log.timestamp;
      }
      consecutive100End = log.timestamp;
    } else {
      // Если был период с RH=100, проверяем его длительность
      if (consecutive100Start !== null && consecutive100End !== null) {
        const duration = consecutive100End - consecutive100Start;
        if (duration >= EIGHT_HOURS) {
          return true;
        }
      }
      consecutive100Start = null;
      consecutive100End = null;
    }
  }

  // Проверяем последний период (если он еще не закончился)
  if (consecutive100Start !== null && consecutive100End !== null) {
    const duration = consecutive100End - consecutive100Start;
    if (duration >= EIGHT_HOURS) {
      return true;
    }
  }

  return false;
}

/**
 * Проверяет, что RH и T не меняются вообще на видимом периоде
 * @param {Array} logArr - массив логов с timestamp и data
 * @returns {boolean}
 */
export function checkNoChangeInRHAndT(logArr) {
  if (!logArr || logArr.length < 2) return false;

  const logs = healthCheckLogs(logArr);
  if (logs.length < 2) return false;

  const rhValues = logs.map((d) => d?.data?.humidity).filter((v) => v !== undefined && v !== null);
  const tValues = logs.map((d) => d?.data?.temperature).filter((v) => v !== undefined && v !== null);

  if (rhValues.length < 2 || tValues.length < 2) return false;

  // Проверяем, что все значения одинаковые (или почти одинаковые с учетом погрешности)
  const rhFirst = rhValues[0];
  const tFirst = tValues[0];
  const EPSILON = 0.01; // погрешность для сравнения

  const rhAllSame = rhValues.every(v => Math.abs(v - rhFirst) < EPSILON);
  const tAllSame = tValues.every(v => Math.abs(v - tFirst) < EPSILON);

  return rhAllSame && tAllSame;
}

/**
 * Проверяет резкие скачки RH (60 → 20 → 65 → 25 мгновенно)
 * @param {Array} logArr - массив логов с timestamp и data
 * @returns {boolean}
 */
export function checkRHInstantJumps(logArr) {
  if (!logArr || logArr.length < 3) return false;

  const logs = healthCheckLogs(logArr);
  if (logs.length < 3) return false;

  const rhValues = logs.map((d) => d?.data?.humidity).filter((v) => v !== undefined && v !== null);
  if (rhValues.length < 3) return false;

  const JUMP_THRESHOLD = 30; // порог для резкого скачка (например, 60 → 20 = 40)

  for (let i = 1; i < rhValues.length; i++) {
    const prev = rhValues[i - 1];
    const curr = rhValues[i];
    const jump = Math.abs(curr - prev);

    if (jump > JUMP_THRESHOLD) {
      // Проверяем, что это действительно резкий скачок туда-сюда
      if (i >= 2) {
        const prev2 = rhValues[i - 2];
        const jump1 = Math.abs(prev - prev2);
        const jump2 = Math.abs(curr - prev);
        // Если есть паттерн: большое изменение → большое изменение в обратную сторону
        if (jump1 > JUMP_THRESHOLD && jump2 > JUMP_THRESHOLD) {
          return true;
        }
      }
    }
  }

  return false;
}

// Шум
/**
 * Собирает метрики шума за видимый на графике период.
 * @param {Array} logArr
 * @returns {Object|null}
 */
function getNoiseStats(logArr) {
  if (!logArr || logArr.length < 10) return null;

  const windowLogs = healthCheckLogs(logArr);
  if (windowLogs.length < 10) return null;

  const avgValues = [];
  const maxValues = [];
  const pairKeyCount = new Map();
  let nearSameCount = 0;
  let spikeCount = 0;
  let firstValidTs = null;
  let lastValidTs = null;

  for (const log of windowLogs) {
    const avg = Number(log?.data?.noiseavg);
    const max = Number(log?.data?.noisemax);
    if (!Number.isFinite(avg) || !Number.isFinite(max) || avg <= 0 || max <= 0) continue;

    if (firstValidTs === null) firstValidTs = log.timestamp;
    lastValidTs = log.timestamp;

    avgValues.push(avg);
    maxValues.push(max);

    const pairKey = `${Math.round(avg)}:${Math.round(max)}`;
    pairKeyCount.set(pairKey, (pairKeyCount.get(pairKey) || 0) + 1);

    if (Math.abs(max - avg) <= 0.3) nearSameCount++;
    if (max - avg >= 2) spikeCount++;
  }

  const validCount = avgValues.length;
  if (validCount < 10 || firstValidTs === null || lastValidTs === null) return null;

  const avgMean = avgValues.reduce((a, b) => a + b, 0) / validCount;
  const avgVariance = avgValues.reduce((a, b) => a + Math.pow(b - avgMean, 2), 0) / validCount;
  const avgStd = Math.sqrt(avgVariance);

  const maxMean = maxValues.reduce((a, b) => a + b, 0) / validCount;
  const maxVariance = maxValues.reduce((a, b) => a + Math.pow(b - maxMean, 2), 0) / validCount;
  const maxStd = Math.sqrt(maxVariance);

  const dominantPair = Math.max(...pairKeyCount.values());

  return {
    validCount,
    durationSec: lastValidTs - firstValidTs,
    avgMean,
    avgStd,
    maxStd,
    avgRange: Math.max(...avgValues) - Math.min(...avgValues),
    maxRange: Math.max(...maxValues) - Math.min(...maxValues),
    nearSameRatio: nearSameCount / validCount,
    spikeRatio: spikeCount / validCount,
    dominantPairRatio: dominantPair / validCount,
  };
}

/**
 * Прямое правило: если шум "залип" около высокого уровня (80+ dB)
 * на протяжении 12+ часов ВНУТРИ ОДНОГО ДНЯ, считаем это проблемой датчика.
 * @param {Array} logArr
 * @returns {boolean}
 */
export function checkNoiseLongFlatline80(logArr) {
  const TWELVE_HOURS = 12 * 3600;
  if (!logArr || logArr.length < 12) return false;

  // Группируем точки по дню в UTC (YYYY-MM-DD)
  const byDay = new Map();
  for (const log of logArr) {
    const ts = Number(log?.timestamp);
    const v = Number(log?.data?.noiseavg ?? log?.data?.noisemax);
    if (!Number.isFinite(ts) || ts <= 0) continue;
    if (!Number.isFinite(v) || v <= 0) continue;

    const dateKey = new Date(ts * 1000).toISOString().slice(0, 10);
    if (!byDay.has(dateKey)) byDay.set(dateKey, []);
    byDay.get(dateKey).push({ timestamp: ts, value: v });
  }

  // Проверяем каждый день независимо
  for (const dayPoints of byDay.values()) {
    if (!dayPoints || dayPoints.length < 12) continue;
    dayPoints.sort((a, b) => a.timestamp - b.timestamp);

    const duration = dayPoints[dayPoints.length - 1].timestamp - dayPoints[0].timestamp;
    if (duration < TWELVE_HOURS) continue;

    const values = dayPoints.map((p) => p.value);
    const mean = values.reduce((a, b) => a + b, 0) / values.length;
    const variance = values.reduce((a, b) => a + Math.pow(b - mean, 2), 0) / values.length;
    const std = Math.sqrt(variance);
    const range = Math.max(...values) - Math.min(...values);

    if (mean >= 80 && std <= 0.7 && range <= 2) {
      return true;
    }
  }

  return false;
}

/**
 * Проверяет, что noise AVG и noise MAX одинаковые в течение 5 часов и больше
 * @param {Array} logArr - массив логов с timestamp и data
 * @returns {boolean}
 */
export function checkNoiseAvgMaxSame(logArr) {
  const stats = getNoiseStats(logArr);
  if (!stats) return false;

  // Вариант 1: доминирующая пара значений и почти полное совпадение avg/max.
  const dominantPairFlatline = (
    stats.durationSec >= 36 * 3600 &&
    stats.avgMean >= 70 &&
    stats.nearSameRatio >= 0.9 &&
    stats.dominantPairRatio >= 0.45 &&
    stats.avgStd <= 0.8 &&
    stats.spikeRatio <= 0.08
  );

  // Вариант 2: "квантованное" высокое плато (например 81-82 dB),
  // где из-за мелкой дребезги нет одной доминирующей пары,
  // но сам сигнал очевидно залипший.
  const quantizedHighFlatline = (
    stats.durationSec >= 24 * 3600 &&
    stats.avgMean >= 75 &&
    stats.nearSameRatio >= 0.9 &&
    stats.avgStd <= 0.5 &&
    stats.avgRange <= 1.5 &&
    stats.maxRange <= 2.5 &&
    stats.spikeRatio <= 0.1
  );

  return dominantPairFlatline || quantizedHighFlatline;
}

/**
 * Проверяет, что Noise max < 35 и avg < 20 в течение 3 часов и больше
 * Учитывает, что в тихих местах это может быть нормально
 * Проверяем только если значения подозрительно низкие И это продолжается долго
 * @param {Array} logArr - массив логов с timestamp и data
 * @returns {boolean}
 */
export function checkNoiseTooLow(logArr) {
  const stats = getNoiseStats(logArr);
  if (!stats) return false;

  // Очень низкий и почти "цифровой" шум долгое время — это скорее поломка канала.
  // Просто тихая среда (лес, парк) сюда обычно не попадает.
  return (
    stats.durationSec >= 24 * 3600 &&
    stats.avgMean < 12 &&
    stats.avgStd < 0.25 &&
    stats.maxStd < 0.25 &&
    stats.nearSameRatio >= 0.95 &&
    stats.dominantPairRatio >= 0.5
  );
}

/**
 * Проверяет, что значения шума не меняются в диапазоне больше 3 часов
 * Учитывает, что в тихих местах значения могут быть стабильными
 * Проверяем только если значения "залипли" на одном числе
 * @param {Array} logArr - массив логов с timestamp и data
 * @returns {boolean}
 */
export function checkNoiseNoChange(logArr) {
  const stats = getNoiseStats(logArr);
  if (!stats) return false;

  // Недельный паттерн "залипания": почти неизменный сигнал в течение долгого времени.
  // Для тихих, но живых датчиков обычно есть больше разброса или пиков.
  return (
    stats.durationSec >= 48 * 3600 &&
    stats.avgStd < 0.45 &&
    stats.avgRange <= 2 &&
    stats.maxRange <= 3 &&
    stats.dominantPairRatio >= 0.5 &&
    stats.nearSameRatio >= 0.88 &&
    stats.spikeRatio <= 0.05
  );
}

/**
 * Проверяет стабильность температуры и влажности
 * @param {Array} logArr - массив логов с timestamp и data
 * @returns {Object} - результаты всех проверок
 */
export function checkClimateStability(logArr) {
  if (!logArr || logArr.length < 2) return {};

  return {
    rh100TooLong: checkRH100ForTooLong(logArr),
    noChange: checkNoChangeInRHAndT(logArr),
    instantJumps: checkRHInstantJumps(logArr)
  };
}

/**
 * Проверяет стабильность шума
 * @param {Array} logArr - массив логов с timestamp и data
 * @returns {Object} - результаты всех проверок
 */
export function checkNoiseStability(logArr) {
  if (!logArr || logArr.length < 2) return {};

  return {
    avgMaxSame: checkNoiseAvgMaxSame(logArr),
    tooLow: checkNoiseTooLow(logArr),
    noChange: checkNoiseNoChange(logArr),
    longFlatline80: checkNoiseLongFlatline80(logArr),
    alwaysZero: checkAlwaysZeroNoise(logArr),
  };
}

/** Порядок категорий в UI (агрегат), в записи дня IDB и в объекте дня. */
const HEALTH_DAY_KEYS = ["pm", "climate", "noise"];

/** Failed health check → metric ids for chart warning labels (fallback without log). */
export const HEALTH_CHECK_METRICS = {
  pm: {
    stableStd: ["pm25", "pm10"],
    stableStdPM25: ["pm25"],
    stableStdPM10: ["pm10"],
    instantJumps: ["pm25", "pm10"],
    lowRatio: ["pm25", "pm10"],
    impossiblePM: ["pm25", "pm10"],
    alwaysZeroPM25: ["pm25"],
    alwaysZeroPM10: ["pm10"],
  },
  climate: {
    rh100TooLong: ["humidity"],
    noChange: ["temperature", "humidity"],
    instantJumps: ["humidity"],
  },
  noise: {
    avgMaxSame: ["noiseavg", "noisemax"],
    tooLow: ["noiseavg", "noisemax"],
    noChange: ["noiseavg", "noisemax"],
    longFlatline80: ["noiseavg", "noisemax"],
    alwaysZero: ["noiseavg", "noisemax"],
  },
};

const HEALTH_CATEGORY_META_KEYS = new Set(["isHealthy", "healthy", "checks", "userhide"]);

function normalizeChecksObject(catOrChecks) {
  if (!catOrChecks || typeof catOrChecks !== "object") return {};
  if (catOrChecks.checks && typeof catOrChecks.checks === "object") {
    return catOrChecks.checks;
  }
  const out = {};
  for (const [key, value] of Object.entries(catOrChecks)) {
    if (!HEALTH_CATEGORY_META_KEYS.has(key) && typeof value === "boolean") {
      out[key] = value;
    }
  }
  return out;
}

/** Whether a category aggregate / check result should show a warning. */
export function isLogsHealthCategoryUnhealthy(categoryState) {
  if (!categoryState || typeof categoryState !== "object") return false;
  if (categoryState.healthy === false) return true;
  return Object.values(normalizeChecksObject(categoryState)).some((v) => v === true);
}

/** Metric ids that failed health checks in a category. */
export function unhealthyMetricIdsForCategory(categoryKey, checksLike) {
  const checks = normalizeChecksObject(checksLike);
  const mapping = HEALTH_CHECK_METRICS[categoryKey];
  if (!mapping) return [];
  const ids = new Set();
  for (const [checkName, failed] of Object.entries(checks)) {
    if (failed !== true) continue;
    const metrics = mapping[checkName];
    if (Array.isArray(metrics)) {
      metrics.forEach((id) => ids.add(id));
    }
  }
  return [...ids];
}

const PM_METRIC_ORDER = ["pm25", "pm10"];
const CLIMATE_METRIC_ORDER = ["temperature", "humidity"];
const NOISE_METRIC_ORDER = ["noiseavg", "noisemax"];

function sortMetricIds(ids, preferredOrder) {
  const set = new Set(ids);
  const ordered = preferredOrder.filter((id) => set.has(id));
  for (const id of set) {
    if (!ordered.includes(id)) ordered.push(id);
  }
  return ordered;
}

function pmValuesFromLog(logArr) {
  if (!Array.isArray(logArr) || logArr.length < 2) {
    return { pm25Values: [], pm10Values: [] };
  }
  const logs = healthCheckLogs(logArr);
  return {
    pm25Values: logs.map((d) => d?.data?.pm25),
    pm10Values: logs.map((d) => d?.data?.pm10),
  };
}

function pmMetricHasData(values) {
  return values.some((v) => v !== undefined && v !== null && Number.isFinite(Number(v)));
}

function resolvePmUnhealthyMetricIds(checks, logArr) {
  const anyFailed = Object.values(checks).some((v) => v === true);
  if (!anyFailed) return [];

  const ids = new Set();

  if (Array.isArray(logArr) && logArr.length > 1) {
    const { pm25Values, pm10Values } = pmValuesFromLog(logArr);

    if (checks.stableStd || checks.stableStdPM25 || checks.stableStdPM10) {
      if (pmMetricHasData(pm25Values)) ids.add("pm25");
      if (pmMetricHasData(pm10Values)) ids.add("pm10");
    }

    if (checkStdDeviation(pm25Values, 0.3)) ids.add("pm25");
    if (checkStdDeviation(pm10Values, 0.5)) ids.add("pm10");
    if (checkAlwaysZeroPM25(pm25Values)) ids.add("pm25");
    if (checkAlwaysZeroPM10(pm10Values)) ids.add("pm10");

    if (checks.instantJumps) {
      if (checkInstantJumps(pm25Values)) ids.add("pm25");
      if (checkInstantJumps(pm10Values)) ids.add("pm10");
    }

    if (checks.impossiblePM || checks.lowRatio) {
      ids.add("pm25");
      ids.add("pm10");
    }
  }

  if (!ids.size) {
    unhealthyMetricIdsForCategory("pm", checks).forEach((id) => ids.add(id));
  }

  return sortMetricIds(ids, PM_METRIC_ORDER);
}

function resolveClimateUnhealthyMetricIds(checks, logArr) {
  const anyFailed = Object.values(checks).some((v) => v === true);
  if (!anyFailed) return [];

  const ids = new Set();
  if (checks.rh100TooLong) ids.add("humidity");
  if (checks.instantJumps) ids.add("humidity");

  if (checks.noChange && Array.isArray(logArr) && logArr.length > 1) {
    const logs = healthCheckLogs(logArr);
    const rhValues = logs
      .map((d) => d?.data?.humidity)
      .filter((v) => v !== undefined && v !== null);
    const tValues = logs
      .map((d) => d?.data?.temperature)
      .filter((v) => v !== undefined && v !== null);
    const EPSILON = 0.01;

    if (rhValues.length >= 2 && rhValues.every((v) => Math.abs(v - rhValues[0]) < EPSILON)) {
      ids.add("humidity");
    }
    if (tValues.length >= 2 && tValues.every((v) => Math.abs(v - tValues[0]) < EPSILON)) {
      ids.add("temperature");
    }
  } else if (checks.noChange) {
    ids.add("temperature");
    ids.add("humidity");
  }

  if (!ids.size) {
    unhealthyMetricIdsForCategory("climate", checks).forEach((id) => ids.add(id));
  }

  return sortMetricIds(ids, CLIMATE_METRIC_ORDER);
}

function resolveNoiseUnhealthyMetricIds(checks) {
  const ids = unhealthyMetricIdsForCategory("noise", checks);
  return sortMetricIds(ids, NOISE_METRIC_ORDER);
}

/**
 * Metric ids for chart warning: per-metric resolution when log is available.
 */
export function resolveUnhealthyMetricIds(categoryKey, checksLike, logArr = null) {
  const checks = normalizeChecksObject(checksLike);
  if (!Object.values(checks).some((v) => v === true)) return [];

  switch (categoryKey) {
    case "pm":
      return resolvePmUnhealthyMetricIds(checks, logArr);
    case "climate":
      return resolveClimateUnhealthyMetricIds(checks, logArr);
    case "noise":
      return resolveNoiseUnhealthyMetricIds(checks);
    default:
      return unhealthyMetricIdsForCategory(categoryKey, checks);
  }
}

/** Сырые проверки по категории (до categoryHealthFromChecks / dayCategoryFromChecks). */
const HEALTH_CHECKS_BY_CATEGORY = {
  pm: checkStability,
  climate: checkClimateStability,
  noise: checkNoiseStability,
};

/** Для UI: объект проверок + флаг healthy (ни один boolean-check не true). */
function categoryHealthFromChecks(checks) {
  return {
    healthy: !Object.values(checks).some((v) => v === true),
    checks,
  };
}

/** Для IDB по дню: те же checks + isHealthy для совместимости с aggregateLogsHealthForVisible. */
function dayCategoryFromChecks(checks) {
  return { isHealthy: !Object.values(checks).some(Boolean), ...checks };
}

function allCategoriesEmptyUiHealth() {
  return Object.fromEntries(
    HEALTH_DAY_KEYS.map((key) => [key, { healthy: true, checks: {} }])
  );
}

/**
 * Проверяет стабильность всех типов данных и возвращает агрегат logsHealth по категориям
 * @param {Array} logArr - массив логов с timestamp и data
 * @returns {Object} - объект с healthy/checks для pm, climate, noise
 */
export function checkAllLogsHealth(logArr) {
  if (!logArr || logArr.length < 2) {
    return allCategoriesEmptyUiHealth();
  }

  return Object.fromEntries(
    HEALTH_DAY_KEYS.map((key) => [
      key,
      categoryHealthFromChecks(HEALTH_CHECKS_BY_CATEGORY[key](logArr)),
    ])
  );
}

// --- logsHealth: схема записи в IndexedDB, мерж по дням, агрегат для UI ---

const DATE_KEY_RE = /^\d{4}-\d{2}-\d{2}$/;

function isDateKey(k) {
  return DATE_KEY_RE.test(String(k));
}

/** id + userhide + lastChecked из произвольного объекта (сырой IDB или уже нормализованная запись). */
function logsHealthRecordShell(sensorId, rawLike) {
  const out = { id: sensorId, userhide: Boolean(rawLike?.userhide) };
  if (rawLike?.lastChecked != null) out.lastChecked = rawLike.lastChecked;
  return out;
}

/** Копирует только вложенные объекты по ключам YYYY-MM-DD. */
function copyDayEntriesFrom(source, target) {
  if (!source || typeof source !== "object") return;
  for (const k of Object.keys(source)) {
    if (isDateKey(k) && source[k] && typeof source[k] === "object") {
      target[k] = source[k];
    }
  }
}

const sensorsIdbSchema = idbschemas?.Sensors;
const sensorsIdbDbName = sensorsIdbSchema?.dbname ?? null;
const LOGS_HEALTH_STORE = "logsHealth";
const logsHealthStoreName = sensorsIdbSchema?.stores?.[LOGS_HEALTH_STORE]
  ? LOGS_HEALTH_STORE
  : null;

function defaultLogsHealthUi() {
  return Object.fromEntries(
    HEALTH_DAY_KEYS.map((key) => [key, { healthy: true, checks: {} }])
  );
}

/** Дефолтное тело категории в записи дня (IDB), до мержа из логов. */
const HEALTHY_DAY_EMPTY_BY_CATEGORY = {
  climate: { 
    isHealthy: true, 
    rh100TooLong: false, 
    noChange: false, 
    instantJumps: false 
  },
  noise: {
    isHealthy: true,
    avgMaxSame: false,
    longFlatline80: false,
    noChange: false,
    tooLow: false,
    alwaysZero: false,
  },
  pm: {
    isHealthy: true,
    alwaysZeroPM25: false,
    alwaysZeroPM10: false,
    impossiblePM: false,
    instantJumps: false,
    lowRatio: false,
    stableStd: false,
    stableStdPM25: false,
    stableStdPM10: false,
  },
};

/** Пустая запись дня */
function healthyDayEntry() {
  return {
    ...Object.fromEntries(
      HEALTH_DAY_KEYS.map((key) => [key, { ...HEALTHY_DAY_EMPTY_BY_CATEGORY[key] }])
    ),
    userhide: false,
  };
}

function buildDayEntry(dayLogs) {
  if (!dayLogs || dayLogs.length < 2) {
    return healthyDayEntry();
  }
  return {
    ...Object.fromEntries(
      HEALTH_DAY_KEYS.map((key) => [
        key,
        dayCategoryFromChecks(HEALTH_CHECKS_BY_CATEGORY[key](dayLogs)),
      ])
    ),
    userhide: false,
  };
}

function partitionLogsByDay(logArr) {
  const map = new Map();
  if (!Array.isArray(logArr)) return map;
  for (const item of logArr) {
    const ts = item?.timestamp;
    if (ts === undefined || ts === null) continue;
    const ms = ts < 1e12 ? ts * 1000 : ts;
    const day = dayISO(ms);
    if (!map.has(day)) map.set(day, []);
    map.get(day).push(item);
  }
  for (const arr of map.values()) {
    arr.sort((a, b) => a.timestamp - b.timestamp);
  }
  return map;
}

/** Запись из IDB: id, userhide, lastChecked?, только ключи YYYY-MM-DD → объект дня. */
function normalizeRecord(raw, sensorId) {
  const out = logsHealthRecordShell(sensorId, raw);
  if (raw && typeof raw === "object") copyDayEntriesFrom(raw, out);
  return out;
}

function scrubRecordForPut(rec) {
  const out = logsHealthRecordShell(rec.id, rec);
  copyDayEntriesFrom(rec, out);
  return out;
}

/**
 * Агрегат для UI (Chart / AQI): по видимым датам; userhide на сенсоре или на дне глушит предупреждения.
 */
export function aggregateLogsHealthForVisible(record, visibleDates) {
  if (!record || record.userhide) return defaultLogsHealthUi();
  const dates =
    Array.isArray(visibleDates) && visibleDates.length > 0
      ? visibleDates
      : Object.keys(record).filter(isDateKey).sort();
  if (!dates.length) return defaultLogsHealthUi();

  const ok = Object.fromEntries(HEALTH_DAY_KEYS.map((key) => [key, true]));
  const mergedChecks = Object.fromEntries(HEALTH_DAY_KEYS.map((key) => [key, {}]));
  const categoryLooksHealthy = (cat) =>
    !cat || typeof cat !== "object" || cat.isHealthy !== false;

  for (const date of dates) {
    const day = record[date];
    if (!day || typeof day !== "object" || day.userhide) continue;
    for (const key of HEALTH_DAY_KEYS) {
      const cat = day[key];
      if (!categoryLooksHealthy(cat)) ok[key] = false;
      for (const [checkName, checkVal] of Object.entries(normalizeChecksObject(cat))) {
        if (checkVal === true) mergedChecks[key][checkName] = true;
      }
    }
  }
  return Object.fromEntries(
    HEALTH_DAY_KEYS.map((key) => [key, { healthy: ok[key], checks: mergedChecks[key] }])
  );
}

function resolveVisibleDates(logs, context) {
  const { currentDate, timelineMode } = context || {};
  if (currentDate) {
    return enumeratePeriodDates(currentDate, timelineMode || "day");
  }
  const map = partitionLogsByDay(Array.isArray(logs) ? logs : []);
  return [...map.keys()].sort();
}

/**
 * Мержит health по дням из логов: пересчитываем только если в IDB нет дня или день — сегодня.
 * @returns {{ record: object, changed: boolean }}
 */
function dayNeedsMergeFromLogs(dayKey, existingDay, todayIso) {
  return dayKey === todayIso || !existingDay || typeof existingDay !== "object";
}

function mergeLogsIntoRecord(existing, fullLogs, sensorId, todayIso) {
  let changed = false;
  const out = {
    ...existing,
    id: sensorId,
    userhide: Boolean(existing.userhide),
  };

  const partition = partitionLogsByDay(fullLogs);

  for (const [d, dayLogs] of partition) {
    if (!dayNeedsMergeFromLogs(d, out[d], todayIso)) continue;
    const built = buildDayEntry(dayLogs);
    built.userhide = out[d]?.userhide === true;
    out[d] = built;
    changed = true;
  }
  if (partition.has(todayIso)) {
    out.lastChecked = Date.now();
    changed = true;
  }
  return { record: out, changed };
}

async function getRecentLogsForHealth(sensorId) {
  const now = Math.floor(Date.now() / 1000);
  const ONE_WEEK_AGO = now - 7 * 24 * 60 * 60;

  try {
    const logs = await getSensorData(sensorId, ONE_WEEK_AGO, now, "remote");
    return Array.isArray(logs) ? logs : [];
  } catch (error) {
    console.error(`Error fetching logs for sensor ${sensorId}:`, error);
    return [];
  }
}

async function expandedLogsForHealth(sensorId, logs) {
  const recentLogs = await getRecentLogsForHealth(sensorId);
  if (!Array.isArray(logs) || logs.length === 0) {
    return recentLogs;
  }
  const merged = [...logs, ...recentLogs];
  const byTs = new Map();
  for (const item of merged) {
    const ts = item?.timestamp;
    if (ts !== undefined && ts !== null) byTs.set(ts, item);
  }
  return Array.from(byTs.values()).sort((a, b) => a.timestamp - b.timestamp);
}

async function readLogsHealthRecord(sensorId) {
  const raw = await IDBgetByKey(sensorsIdbDbName, logsHealthStoreName, sensorId);
  return normalizeRecord(raw, sensorId);
}

function idbPutLogsHealth(record) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const fail = (msg, err) => {
      if (settled) return;
      settled = true;
      console.error(msg, err || "");
      reject(err || new Error(msg));
    };
    const timer = globalThis.setTimeout(() => {
      fail(
        "logsHealth IDB: транзакция не открылась (нет стора / IndexedDB). Проверьте dbversion и stores.logsHealth в idb-schemas."
      );
    }, 5000);

    IDBworkflow(sensorsIdbDbName, logsHealthStoreName, "readwrite", (store) => {
      globalThis.clearTimeout(timer);
      if (settled) return;
      const payload = scrubRecordForPut(record);
      const request = store.put(payload);
      request.onsuccess = () => {
        if (settled) return;
        settled = true;
        notifyDBChange(sensorsIdbDbName, logsHealthStoreName);
        resolve();
      };
      request.onerror = (e) => fail("logsHealth IDB: put error", e);
    });
  });
}

async function getOrCheckLogsHealth(sensorId, logs, context) {
  if (!sensorsIdbDbName || !logsHealthStoreName) {
    syncLogsHealthMeta(sensorId, null);
    return defaultLogsHealthUi();
  }

  const visibleDates = resolveVisibleDates(logs, context);
  let record = await readLogsHealthRecord(sensorId);
  const todayIso = dayISO();
  const hasClientLogs = Array.isArray(logs) && logs.length >= 1;

  if (hasClientLogs) {
    const { record: merged, changed } = mergeLogsIntoRecord(record, logs, sensorId, todayIso);
    record = merged;
    if (changed) {
      await idbPutLogsHealth(record);
    }
  }

  syncLogsHealthMeta(sensorId, record, visibleDates, context);
  return aggregateLogsHealthForVisible(record, visibleDates);
}

export async function checkAndSaveLogsHealth(sensorId, logs = null, context = {}) {
  if (!sensorsIdbDbName || !logsHealthStoreName) {
    console.warn("Sensors IDB: schema or stores.logsHealth missing in idb-schemas");
    syncLogsHealthMeta(sensorId, null);
    return defaultLogsHealthUi();
  }

  try {
    const expanded = await expandedLogsForHealth(sensorId, logs);
    let record = await readLogsHealthRecord(sensorId);
    const todayIso = dayISO();

    if (expanded.length >= 1) {
      const { record: merged, changed } = mergeLogsIntoRecord(record, expanded, sensorId, todayIso);
      record = merged;
      if (changed) {
        await idbPutLogsHealth(record);
      }
    }

    const visibleDates = resolveVisibleDates(expanded, context);
    syncLogsHealthMeta(sensorId, record, visibleDates, context);
    return aggregateLogsHealthForVisible(record, visibleDates);
  } catch (error) {
    console.error(`Error checking logs health for sensor ${sensorId}:`, error);
    syncLogsHealthMeta(sensorId, null);
    return defaultLogsHealthUi();
  }
}

/** Агрегат healthy по категориям для UI (useLogsHealth / loadLogsHealth). */
const logsHealthShared = ref(null);
const logsHealthLoadingShared = ref(false);
const logsHealthErrorShared = ref(null);

/** userhide по сенсору + флаг userhide по дням в видимом периоде (для UI). */
const logsHealthMetaShared = ref({
  sensorId: null,
  userhide: false,
  anyVisibleDayUserhide: false,
});

function syncLogsHealthMeta(sensorId, record, visibleDates, context) {
  if (!sensorId) {
    logsHealthMetaShared.value = {
      sensorId: null,
      userhide: false,
      anyVisibleDayUserhide: false,
    };
    return;
  }
  let anyVisibleDayUserhide = false;
  if (record) {
    if (Array.isArray(visibleDates) && visibleDates.length > 0) {
      anyVisibleDayUserhide = visibleDates.some((d) => record[d]?.userhide === true);
    }
    // Запасной вариант: те же границы, что у таймлайна (неделя/месяц), без зависимости от enumeratePeriodDates
    if (!anyVisibleDayUserhide && context?.currentDate) {
      const mode = context.timelineMode === "realtime" ? "day" : context.timelineMode || "day";
      const { start, end } = getPeriodBounds(context.currentDate, mode);
      const lo = dayISO(start * 1000);
      const hi = dayISO(end * 1000);
      for (const k of Object.keys(record)) {
        if (!isDateKey(k)) continue;
        if (k >= lo && k <= hi && record[k]?.userhide === true) {
          anyVisibleDayUserhide = true;
          break;
        }
      }
    }
  }
  logsHealthMetaShared.value = {
    sensorId,
    userhide: Boolean(record?.userhide),
    anyVisibleDayUserhide,
  };
}

async function runLogsHealthUiTask(sensorId, fetchLogsHealth, errorMessage) {
  if (!sensorId) {
    logsHealthShared.value = null;
    syncLogsHealthMeta(null, null);
    return;
  }

  logsHealthLoadingShared.value = true;
  logsHealthErrorShared.value = null;

  try {
    logsHealthShared.value = await fetchLogsHealth();
  } catch (err) {
    console.error(errorMessage, err);
    logsHealthErrorShared.value = err;
    logsHealthShared.value = null;
    syncLogsHealthMeta(null, null);
  } finally {
    logsHealthLoadingShared.value = false;
  }
}

export async function loadLogsHealth(sensorId, logs = null, context = {}) {
  return runLogsHealthUiTask(
    sensorId,
    () => getOrCheckLogsHealth(sensorId, logs, context),
    "Error loading logs health:"
  );
}

export async function refreshLogsHealth(sensorId, logs = null, context = {}) {
  return runLogsHealthUiTask(
    sensorId,
    () => checkAndSaveLogsHealth(sensorId, logs, context),
    "Error refreshing logs health:"
  );
}

/** Скрыть предупреждения для всего сенсора (все даты). */
export async function setLogsHealthSensorUserHide(sensorId, hidden) {
  if (!sensorsIdbDbName || !logsHealthStoreName || !sensorId) return;
  const record = await readLogsHealthRecord(sensorId);
  record.userhide = Boolean(hidden);
  await idbPutLogsHealth(record);
  syncLogsHealthMeta(sensorId, record);
}

/** Снять userhide на сенсоре и на всех днях записи logsHealth для этого датчика. */
export async function clearAllLogsHealthUserHide(sensorId) {
  if (!sensorsIdbDbName || !logsHealthStoreName || !sensorId) return;
  const record = await readLogsHealthRecord(sensorId);
  record.userhide = false;
  for (const k of Object.keys(record)) {
    if (!isDateKey(k)) continue;
    const day = record[k];
    if (!day || typeof day !== "object") continue;
    record[k] = { ...day, userhide: false };
  }
  await idbPutLogsHealth(record);
  syncLogsHealthMeta(sensorId, record);
}

/** Скрыть предупреждения для одной даты YYYY-MM-DD. */
export async function setLogsHealthDayUserHide(sensorId, dayIso, hidden) {
  if (!sensorsIdbDbName || !logsHealthStoreName || !sensorId || !isDateKey(dayIso)) return;
  const record = await readLogsHealthRecord(sensorId);
  const prev = record[dayIso] && typeof record[dayIso] === "object" ? record[dayIso] : healthyDayEntry();
  record[dayIso] = { ...prev, userhide: Boolean(hidden) };
  await idbPutLogsHealth(record);
}

/**
 * Реактивное состояние проверки качества логов (IndexedDB + окно логов).
 * Модульные refs — несколько компонентов видят одни и те же данные.
 */
export function useLogsHealth() {
  return {
    logsHealth: logsHealthShared,
    logsHealthMeta: logsHealthMetaShared,
    isLoading: logsHealthLoadingShared,
    error: logsHealthErrorShared,
    loadLogsHealth,
    refreshLogsHealth,
  };
}
