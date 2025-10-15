// --- Константы с настройками обработки файлов ---------------------------------
const MAX_FILE_SIZE_BYTES = 1024 * 1024 * 1024; // 1 ГБ
const DEFAULT_KEY_HEADER = 'POLICY_NO';
const RESERVED_COLUMN_NAMES = new Set(['__proto__', 'prototype', 'constructor']);
const TABLE_FORMATS = {
    csv: { label: 'CSV (.csv)', extensions: ['.csv'], accept: '.csv', reader: readDelimitedFile },
    txt: { label: 'Текстовый (.txt)', extensions: ['.txt'], accept: '.txt', reader: readDelimitedFile },
    xlsx: { label: 'Excel (.xlsx)', extensions: ['.xlsx'], accept: '.xlsx', reader: readExcelFile },
    xls: { label: 'Excel 97-2003 (.xls)', extensions: ['.xls'], accept: '.xls', reader: readExcelFile }
};
const FALLBACK_DELIMITERS = [';', '\t', '|'];
const DELIMITER_CANDIDATES = [',', ...FALLBACK_DELIMITERS];
const DELIMITER_SNIFF_SAMPLE_BYTES = 128 * 1024; // 128 КБ достаточно для эвристики
const MAX_SAMPLE_LINES_FOR_DETECTION = 50;
const AUTODETECT_DELIMITER_ERROR_MESSAGE = 'Unable to auto-detect delimiting character';
const PAPA_PARSE_CHUNK_SIZE = 512 * 1024; // 512 КБ порции чтения
const REPORT_FORMATS = {
    xlsx: {
        extension: 'xlsx',
        mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    },
    csv: {
        extension: 'csv',
        mimeType: 'text/csv;charset=utf-8;'
    },
    txt: {
        extension: 'txt',
        mimeType: 'text/plain;charset=utf-8;'
    }
};
const DEFAULT_REPORT_FORMAT = 'xlsx';

// --- Настройки блоков с котом-маскотом -----------------------------------------
const LAST_SCENE_STORAGE_KEY = 'csv-check-pro:last-cat-scene';
const CAT_SCENES_SOURCE = 'assets/cat_scenes/cat-scenes.json';
const FALLBACK_CAT_MESSAGE = 'Добавьте новые сцены в каталог assets/cat_scenes, чтобы кот появлялся рядом с отчётами.';
const DEFAULT_CAT_POSITION = 'cat-mascot--top-right';

// --- Переменные для DOM-элементов ----------------------------------------------
let form;
let fileInputA;
let fileInputB;
let tableFormatSelect;
let reportFormatSelect;
let keyFieldInput;
let keyHeader;
let tableBody;
let valueHeaderA;
let valueHeaderB;
let summaryBlock;
let errorBlock;
let downloadReportButton;
let downloadDetailedReportButton;
let loadingIndicator;

// --- Состояние последнего сравнения --------------------------------------------
let lastDifferences = [];
let lastFileNameA = '';
let lastFileNameB = '';
let lastKeyFieldName = '';

// --- Инициализация браузерной логики -------------------------------------------
if (typeof document !== 'undefined') {
    form = document.getElementById('compare-form');
    fileInputA = document.getElementById('fileA');
    fileInputB = document.getElementById('fileB');
    tableFormatSelect = document.getElementById('tableFormat');
    reportFormatSelect = document.getElementById('reportFormat');
    keyFieldInput = document.getElementById('keyField');
    keyHeader = document.getElementById('key-header');
    tableBody = document.querySelector('#results-table tbody');
    valueHeaderA = document.getElementById('value-header-a');
    valueHeaderB = document.getElementById('value-header-b');
    summaryBlock = document.getElementById('summary');
    errorBlock = document.getElementById('form-error');
    downloadReportButton = document.getElementById('download-report');
    downloadDetailedReportButton = document.getElementById('download-detailed-report');
    loadingIndicator = document.getElementById('loading-indicator');

    // Приводим инпуты в соответствие с выбранным форматом и подключаем кота.
    initializeFormatHandling();
    initializeCatMascot().catch((error) => {
        console.error('Не удалось инициализировать сцену с котом:', error);
    });

    // Основная обработка отправки формы сравнения.
    form?.addEventListener('submit', async (event) => {
        event.preventDefault();
        hideError();

        const fileA = fileInputA?.files?.[0];
        const fileB = fileInputB?.files?.[0];
        const keyField = keyFieldInput?.value.trim();
        const format = tableFormatSelect?.value;

        try {
            validateFormInput(fileA, fileB, keyField, format);
        } catch (validationError) {
            showError(validationError instanceof Error ? validationError.message : String(validationError));
            return;
        }

        if (downloadReportButton) {
            downloadReportButton.disabled = true;
        }
        if (downloadDetailedReportButton) {
            downloadDetailedReportButton.disabled = true;
        }
        showLoadingIndicator();

        try {
            const [datasetA, datasetB] = await Promise.all([
                readTableFile(fileA, format),
                readTableFile(fileB, format)
            ]);

            const result = compareDatasets(datasetA, datasetB, keyField, fileA.name, fileB.name);
            lastDifferences = result.differences;
            lastFileNameA = fileA.name;
            lastFileNameB = fileB.name;
            lastKeyFieldName = result.keyField;

            renderDifferences(result.differences, result.headers);
            renderSummary(result.summaryText);
            const hasDifferences = result.differences.length > 0;
            if (downloadReportButton) {
                downloadReportButton.disabled = !hasDifferences;
            }
            if (downloadDetailedReportButton) {
                downloadDetailedReportButton.disabled = !hasDifferences;
            }
        } catch (error) {
            console.error(error);
            resetTable();
            lastDifferences = [];
            lastFileNameA = '';
            lastFileNameB = '';
            lastKeyFieldName = '';
            if (downloadReportButton) {
                downloadReportButton.disabled = true;
            }
            if (downloadDetailedReportButton) {
                downloadDetailedReportButton.disabled = true;
            }
            renderSummary('');
            showError(error instanceof Error ? error.message : String(error));
        } finally {
            hideLoadingIndicator();
        }
    });

    // Обработчик скачивания сводного отчёта.
    downloadReportButton?.addEventListener('click', () => {
        if (!lastDifferences.length) {
            return;
        }
        try {
            handleReportDownload('aggregated');
        } catch (error) {
            showError(error instanceof Error ? error.message : String(error));
        }
    });

    // Обработчик скачивания подробного отчёта.
    downloadDetailedReportButton?.addEventListener('click', () => {
        if (!lastDifferences.length) {
            return;
        }
        try {
            handleReportDownload('detailed');
        } catch (error) {
            showError(error instanceof Error ? error.message : String(error));
        }
    });
}

function validateFormInput(fileA, fileB, keyField, format) {
    const hasExplicitFormat = typeof format === 'string';
    const resolvedFormat = hasExplicitFormat && format in TABLE_FORMATS ? format : 'csv';
    const formatConfig = TABLE_FORMATS[resolvedFormat];
    if (!formatConfig || (hasExplicitFormat && !(format in TABLE_FORMATS))) {
        throw new Error('Выбран неподдерживаемый формат файлов.');
    }
    if (!fileA || !fileB) {
        throw new Error('Пожалуйста, выберите оба файла для сравнения.');
    }
    if (!keyField) {
        throw new Error('Укажите название ключевого столбца.');
    }
    [fileA, fileB].forEach((file) => {
        if (!isFileOfFormat(file, formatConfig)) {
            throw new Error(`Файл ${file.name} не соответствует выбранному формату (${formatConfig.label}).`);
        }
        if (file.size === 0) {
            throw new Error(`Файл ${file.name} пуст и не может быть обработан.`);
        }
        if (file.size > MAX_FILE_SIZE_BYTES) {
            throw new Error(`Файл ${file.name} превышает допустимый размер 1 ГБ.`);
        }
    });
}

/**
 * Обработать запрос на выгрузку отчёта в выбранном формате.
 * @param {'aggregated'|'detailed'} type
 */
function handleReportDownload(type) {
    const format = getSelectedReportFormat();
    const rows = type === 'aggregated'
        ? buildAggregatedReportData(lastDifferences)
        : buildDetailedReportData(lastDifferences, lastFileNameA, lastFileNameB, lastKeyFieldName);
    const timestamp = Date.now();
    const baseName = type === 'aggregated'
        ? `csv-check-pro-report-${timestamp}`
        : `csv-check-pro-detailed-${timestamp}`;
    const sheetName = type === 'aggregated' ? 'Сводный отчёт' : 'Подробный отчёт';
    triggerReportDownload(rows, format, baseName, sheetName);
}

/**
 * Получить выбранный пользователем формат отчёта.
 * @returns {'xlsx'|'csv'|'txt'}
 */
function getSelectedReportFormat() {
    const rawValue = reportFormatSelect?.value ?? DEFAULT_REPORT_FORMAT;
    if (REPORT_FORMATS[rawValue]) {
        return rawValue;
    }
    if (reportFormatSelect) {
        reportFormatSelect.value = DEFAULT_REPORT_FORMAT;
    }
    return DEFAULT_REPORT_FORMAT;
}

/**
 * Запустить скачивание отчёта в указанном формате.
 * @param {Array<Array<string>>} rows
 * @param {'xlsx'|'csv'|'txt'} format
 * @param {string} filenameBase
 * @param {string} sheetName
 */
function triggerReportDownload(rows, format, filenameBase, sheetName = 'Отчёт') {
    const formatConfig = REPORT_FORMATS[format] ?? REPORT_FORMATS[DEFAULT_REPORT_FORMAT];
    const safeBaseName = sanitizeFilename(filenameBase);

    if (format === 'xlsx') {
        downloadXlsxReport(rows, `${safeBaseName}.${formatConfig.extension}`, sheetName, formatConfig.mimeType);
        return;
    }

    if (format === 'csv') {
        const content = convertRowsToCsv(rows);
        triggerBlobDownload(content, formatConfig.mimeType, `${safeBaseName}.${formatConfig.extension}`);
        return;
    }

    if (format === 'txt') {
        const content = convertRowsToTxt(rows);
        triggerBlobDownload(content, formatConfig.mimeType, `${safeBaseName}.${formatConfig.extension}`);
        return;
    }

    const fallbackContent = convertRowsToCsv(rows);
    triggerBlobDownload(fallbackContent, REPORT_FORMATS.csv.mimeType, `${safeBaseName}.${REPORT_FORMATS.csv.extension}`);
}

/**
 * Скачать отчёт в формате XLSX.
 * @param {Array<Array<string>>} rows
 * @param {string} filename
 * @param {string} sheetName
 * @param {string} mimeType
 */
function downloadXlsxReport(rows, filename, sheetName, mimeType) {
    if (typeof XLSX === 'undefined') {
        throw new Error('Невозможно сформировать Excel-файл: библиотека XLSX не загружена. Обновите страницу и попробуйте снова.');
    }
    const safeSheetName = (sheetName || 'Отчёт').replace(/[\\/*?:\[\]]/g, ' ').trim().slice(0, 31) || 'Отчёт';
    const workbook = XLSX.utils.book_new();
    const worksheet = XLSX.utils.aoa_to_sheet(rows);
    XLSX.utils.book_append_sheet(workbook, worksheet, safeSheetName);
    const arrayBuffer = XLSX.write(workbook, { bookType: 'xlsx', type: 'array' });
    triggerBlobDownload(arrayBuffer, mimeType, filename);
}

/**
 * Преобразовать массив строк отчёта в CSV-представление.
 * @param {Array<Array<string>>} rows
 */
function convertRowsToCsv(rows) {
    // Пример: convertRowsToCsv([['Поле', 'Всего'], ['age', '3']]);
    return rows
        .map((row) => row.map((cell) => escapeCsvValue(cell ?? '')).join(','))
        .join('\r\n');
}

/**
 * Преобразовать массив строк отчёта в текстовое представление.
 * @param {Array<Array<string>>} rows
 */
function convertRowsToTxt(rows) {
    // Пример: convertRowsToTxt([['Поле', 'Всего'], ['age', '3']]);
    return rows
        .map((row) => row.map((cell) => sanitizeTextValue(cell)).join('\t'))
        .join('\r\n');
}

/**
 * Очистить значение текстовой ячейки от перевода строки.
 * @param {string} value
 */
function sanitizeTextValue(value) {
    const stringValue = String(value ?? '');
    return stringValue.replace(/[\r\n\t]+/g, ' ');
}

/**
 * Вспомогательная функция скачивания содержимого как файла.
 * @param {string|ArrayBuffer|Blob} data
 * @param {string} mimeType
 * @param {string} filename
 */
function triggerBlobDownload(data, mimeType, filename) {
    if (typeof document === 'undefined') {
        throw new Error('Скачивание файлов доступно только в браузере.');
    }
    const blob = data instanceof Blob ? data : new Blob([data], { type: mimeType });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.setAttribute('download', sanitizeFilename(filename));
    link.rel = 'noopener';
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
}

/**
 * Очистить имя файла для безопасного скачивания.
 * @param {string} filename
 */
function sanitizeFilename(filename) {
    const normalized = String(filename ?? 'report').trim();
    const withoutPath = normalized.split(/[\\/]+/).filter(Boolean).pop() ?? 'report';
    const sanitized = withoutPath.replace(/[^\w.\-]+/g, '_');
    const withoutLeadingDots = sanitized.replace(/^\.+/, '');
    return withoutLeadingDots || 'report';
}

/**
 * Прочитать табличный файл в зависимости от выбранного формата.
 * @param {File} file
 * @param {string} format
 * @returns {Promise<{ rows: Array<Record<string, string>> }>}
 */
function readTableFile(file, format) {
    const hasExplicitFormat = typeof format === 'string';
    const resolvedFormat = hasExplicitFormat && format in TABLE_FORMATS ? format : 'csv';
    const formatConfig = TABLE_FORMATS[resolvedFormat];
    if (!formatConfig || (hasExplicitFormat && !(format in TABLE_FORMATS))) {
        return Promise.reject(new Error('Формат файлов не поддерживается.'));
    }
    return formatConfig.reader(file, formatConfig);
}

/**
 * Прочитать текстовый файл с разделителями и вернуть массив объектов.
 * Для стабильной работы на слабых устройствах чтение выполняется порциями
 * с повторными попытками при ошибке автоопределения разделителя.
 * @param {File} file
 * @returns {Promise<{ rows: Array<Record<string, string>> }>}
 */
async function readDelimitedFile(file) {
    if (typeof Papa === 'undefined') {
        throw new Error('Библиотека для чтения CSV не загружена. Обновите страницу и попробуйте снова.');
    }

    let sniffedDelimiter = null;
    try {
        sniffedDelimiter = await detectPreferredDelimiter(file);
    } catch (sniffError) {
        console.warn('Не удалось определить разделитель по образцу:', sniffError);
    }

    const delimitersToTry = [];
    const seenDelimiters = new Set();

    if (sniffedDelimiter) {
        delimitersToTry.push(sniffedDelimiter);
        seenDelimiters.add(sniffedDelimiter);
    }

    for (const delimiter of [undefined, ...FALLBACK_DELIMITERS]) {
        const key = delimiter ?? 'auto';
        if (seenDelimiters.has(key)) {
            continue;
        }
        delimitersToTry.push(delimiter);
        seenDelimiters.add(key);
    }

    let lastError = null;

    for (const delimiter of delimitersToTry) {
        try {
            const result = await parseDelimitedFileChunked(file, delimiter);
            if (!delimiter && shouldRetryWithFallbackDelimiter(result)) {
                lastError = new Error(`Не удалось автоматически определить разделитель в файле ${file.name}.`);
                continue;
            }

            const blockingErrors = filterBlockingParsingErrors(result.errors);
            if (blockingErrors.length > 0) {
                const firstError = blockingErrors[0];
                throw new Error(`Ошибка разбора файла ${file.name}: ${firstError.message}`);
            }

            return { rows: result.rows };
        } catch (error) {
            lastError = error instanceof Error ? error : new Error(String(error));
        }
    }

    throw lastError ?? new Error(`Не удалось прочитать файл ${file.name}.`);
}

async function detectPreferredDelimiter(file) {
    if (!file || typeof file.slice !== 'function' || typeof FileReader === 'undefined') {
        return null;
    }

    const sampleText = await readFileSliceAsText(file, DELIMITER_SNIFF_SAMPLE_BYTES);
    if (typeof sampleText !== 'string' || sampleText.trim().length === 0) {
        return null;
    }

    const selected = selectDelimiterFromSample(sampleText);
    return selected === ',' ? null : selected;
}

function selectDelimiterFromSample(sampleText) {
    if (typeof sampleText !== 'string' || sampleText.length === 0) {
        return null;
    }

    const rawLines = sampleText.split(/\r\n|\n|\r/).filter((line) => line.length > 0);
    if (rawLines.length === 0) {
        return null;
    }

    const lines = rawLines.slice(0, MAX_SAMPLE_LINES_FOR_DETECTION);
    let bestDelimiter = null;
    let bestScore = 0;

    for (const candidate of DELIMITER_CANDIDATES) {
        const score = scoreDelimiterLines(lines, candidate);
        if (score > bestScore * 1.05) {
            bestScore = score;
            bestDelimiter = candidate;
        }
    }

    if (!bestDelimiter || bestScore <= 0) {
        return null;
    }

    if (bestDelimiter === ',') {
        return null;
    }

    return bestDelimiter;
}

function scoreDelimiterLines(lines, delimiter) {
    if (!Array.isArray(lines) || lines.length === 0) {
        return 0;
    }

    let validLines = 0;
    let totalCells = 0;
    let minCells = Infinity;
    let maxCells = 0;
    let delimiterOccurrences = 0;

    for (const line of lines) {
        if (typeof line !== 'string' || line.length === 0) {
            continue;
        }
        const cells = line.split(delimiter);
        if (cells.length <= 1) {
            continue;
        }
        validLines += 1;
        totalCells += cells.length;
        delimiterOccurrences += cells.length - 1;
        if (cells.length < minCells) {
            minCells = cells.length;
        }
        if (cells.length > maxCells) {
            maxCells = cells.length;
        }
    }

    if (validLines === 0) {
        return 0;
    }

    const minRequired = Math.max(2, Math.floor(lines.length * 0.3));
    if (validLines < minRequired) {
        return 0;
    }

    const averageCells = totalCells / validLines;
    const consistency = maxCells > 0 ? minCells / maxCells : 0;
    const density = delimiterOccurrences / lines.length;
    if (consistency <= 0) {
        return 0;
    }

    return validLines * averageCells * consistency * (1 + density);
}

function readFileSliceAsText(blob, bytes, encoding = 'utf-8') {
    return new Promise((resolve) => {
        if (!blob || typeof blob.slice !== 'function' || typeof FileReader === 'undefined') {
            resolve(null);
            return;
        }

        const reader = new FileReader();
        reader.addEventListener('error', () => resolve(null));
        reader.addEventListener('abort', () => resolve(null));
        reader.addEventListener('load', () => {
            const text = typeof reader.result === 'string' ? reader.result : null;
            resolve(text);
        });
        try {
            const slice = blob.slice(0, Math.min(bytes, blob.size));
            reader.readAsText(slice, encoding);
        } catch (error) {
            console.warn('Не удалось прочитать часть файла для определения разделителя:', error);
            resolve(null);
        }
    });
}

/**
 * Прочитать CSV/TSV файл кусочками для снижения пиковых затрат памяти.
 * @param {File} file
 * @param {string|undefined} delimiter
 * @returns {Promise<{ rows: Array<Record<string, string>>>, errors: Array<object>, meta: object }>}
 */
function parseDelimitedFileChunked(file, delimiter) {
    return new Promise((resolve, reject) => {
        const aggregatedRows = [];
        const aggregatedErrors = [];
        let fatalError = null;
        let lastChunkMeta = null;
        let abortedDueToUndetectableDelimiter = false;

        const workerSupported = typeof Worker !== 'undefined';

        Papa.parse(file, {
            header: true,
            skipEmptyLines: 'greedy',
            encoding: 'utf-8',
            dynamicTyping: false,
            worker: workerSupported,
            chunkSize: PAPA_PARSE_CHUNK_SIZE,
            delimiter,
            chunk: (results, parser) => {
                const chunkErrors = Array.isArray(results.errors) ? results.errors : [];
                if (chunkErrors.length > 0) {
                    aggregatedErrors.push(...chunkErrors);
                    const blocking = chunkErrors.find((error) => error && error.fatal);
                    if (blocking && !fatalError) {
                        fatalError = blocking;
                    }
                }

                if (Array.isArray(results.data) && results.data.length > 0) {
                    const sanitized = sanitizeRows(results.data);
                    for (const row of sanitized) {
                        aggregatedRows.push(row);
                    }
                }

                if (Array.isArray(results.data)) {
                    results.data.length = 0;
                }

                if (results && results.meta) {
                    lastChunkMeta = results.meta;
                }

                if (fatalError) {
                    parser.abort();
                    return;
                }

                if (!delimiter && chunkErrors.some((error) => isUndetectableDelimiterError(error))) {
                    if (!abortedDueToUndetectableDelimiter) {
                        abortedDueToUndetectableDelimiter = true;
                        parser.abort();
                    }
                }
            },
            complete: (results) => {
                const combinedErrors = aggregatedErrors.concat(Array.isArray(results?.errors) ? results.errors : []);
                const resolvedMeta = results?.meta && Object.keys(results.meta).length > 0
                    ? results.meta
                    : lastChunkMeta ?? {};
                if (fatalError) {
                    reject(new Error(`Ошибка разбора файла ${file.name}: ${fatalError.message}`));
                    return;
                }
                resolve({
                    rows: aggregatedRows,
                    errors: combinedErrors,
                    meta: resolvedMeta
                });
            },
            error: (error) => {
                const message = error instanceof Error ? error.message : String(error ?? 'Неизвестная ошибка');
                reject(new Error(`Не удалось прочитать файл ${file.name}: ${message}`));
            }
        });
    });
}

/**
 * Определить, требуется ли повторить чтение с явным разделителем.
 * @param {{ rows: Array<Record<string, string>>, errors?: Array<object>, meta?: object }} result
 */
function shouldRetryWithFallbackDelimiter(result) {
    if (!result || !Array.isArray(result.errors) || result.errors.length === 0) {
        return false;
    }
    const hasAutodetectError = result.errors.some((error) => isUndetectableDelimiterError(error));
    if (!hasAutodetectError) {
        return false;
    }
    return !hasMeaningfulColumnStructure(result.rows, result.meta);
}

/**
 * Проверить, есть ли в наборе данных больше одного столбца после разбора.
 * @param {Array<Record<string, string>>} rows
 * @param {{ fields?: Array<string> }} meta
 */
function hasMeaningfulColumnStructure(rows, meta = {}) {
    if (Array.isArray(meta.fields)) {
        const meaningfulColumns = meta.fields
            .map((field) => typeof field === 'string' ? field.trim() : String(field ?? '').trim())
            .filter((field) => field.length > 0);
        if (meaningfulColumns.length > 1) {
            return true;
        }
    }
    if (Array.isArray(rows)) {
        for (const row of rows) {
            if (row && typeof row === 'object' && Object.keys(row).length > 1) {
                return true;
            }
        }
    }
    return false;
}

/**
 * Отфильтровать ошибки разбора, которые требуют остановки обработки.
 * @param {Array<object>} errors
 */
function filterBlockingParsingErrors(errors) {
    if (!Array.isArray(errors)) {
        return [];
    }
    return errors.filter((error) => !isIgnorableParsingWarning(error));
}

/**
 * Определить, является ли предупреждение незначительным и его можно игнорировать.
 * @param {object} error
 */
function isIgnorableParsingWarning(error) {
    return isUndetectableDelimiterError(error);
}

/**
 * Проверить, относится ли ошибка Papa Parse к невозможности автоопределения разделителя.
 * @param {object} error
 */
function isUndetectableDelimiterError(error) {
    if (!error) {
        return false;
    }
    if (error.code === 'UndetectableDelimiter') {
        return true;
    }
    if (typeof error.message === 'string' && error.message.includes(AUTODETECT_DELIMITER_ERROR_MESSAGE)) {
        return true;
    }
    return false;
}

/**
 * Прочитать файл Excel и вернуть массив объектов.
 * @param {File} file
 * @returns {Promise<{ rows: Array<Record<string, string>> }>}
 */
function readExcelFile(file) {
    return new Promise((resolve, reject) => {
        if (typeof XLSX === 'undefined') {
            reject(new Error('Библиотека для чтения Excel не загружена. Обновите страницу и попробуйте снова.'));
            return;
        }
        const reader = new FileReader();
        reader.onerror = () => {
            reject(new Error(`Не удалось прочитать файл ${file.name}.`));
        };
        reader.onload = (event) => {
            try {
                const data = new Uint8Array(event.target?.result ?? []);
                const workbook = XLSX.read(data, { type: 'array' });
                if (!workbook.SheetNames.length) {
                    throw new Error('Книга Excel не содержит листов.');
                }
                const sheetName = workbook.SheetNames[0];
                const worksheet = workbook.Sheets[sheetName];
                const rows = XLSX.utils.sheet_to_json(worksheet, { defval: '', raw: false });
                const sanitizedRows = sanitizeRows(rows);
                resolve({ rows: sanitizedRows });
            } catch (excelError) {
                const message = excelError instanceof Error ? excelError.message : String(excelError);
                reject(new Error(`Не удалось обработать Excel файл ${file.name}: ${message}`));
            }
        };
        reader.readAsArrayBuffer(file);
    });
}

/**
 * Загрузить и отобразить сцену с котом-маскотом.
 * @returns {Promise<void>}
 */
async function initializeCatMascot() {
    const root = document.getElementById('cat-mascot-root');
    if (!root) {
        return;
    }

    const scenes = await loadCatScenes(CAT_SCENES_SOURCE);
    if (!scenes.length) {
        renderCatPlaceholder(root);
        return;
    }

    const scene = selectNextScene(scenes);
    if (!scene) {
        renderCatPlaceholder(root);
        return;
    }

    renderCatScene(root, scene);
}

/**
 * Получить список сцен из JSON-файла и отфильтровать некорректные записи.
 * @param {string} source
 * @returns {Promise<Array<{id:string,ariaLabel:string,image:string,message:string,positionClass:string}>>}
 */
async function loadCatScenes(source) {
    if (typeof fetch === 'undefined') {
        return [];
    }
    try {
        const response = await fetch(source, { cache: 'no-store' });
        if (!response.ok) {
            return [];
        }
        const payload = await response.json();
        if (!Array.isArray(payload)) {
            return [];
        }
        return payload
            .map((scene) => sanitizeScene(scene))
            .filter((scene) => Boolean(scene && scene.image && scene.message));
    } catch (error) {
        console.warn('Не удалось загрузить сцены с котом:', error);
        return [];
    }
}

/**
 * Очистить и нормализовать данные сцены перед отображением.
 * @param {any} scene
 */
function sanitizeScene(scene) {
    if (!scene || typeof scene !== 'object') {
        return null;
    }
    const fallbackId = typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
        ? crypto.randomUUID()
        : `generated-${Date.now()}-${Math.random().toString(16).slice(2, 10)}`;
    const id = typeof scene.id === 'string' && scene.id.trim() ? scene.id.trim() : fallbackId;
    const ariaLabel = typeof scene.ariaLabel === 'string' && scene.ariaLabel.trim()
        ? scene.ariaLabel.trim()
        : 'Иллюстрация с котом-маскотом.';
    const image = typeof scene.image === 'string' && scene.image.trim() ? scene.image.trim() : '';
    const message = typeof scene.message === 'string' && scene.message.trim() ? scene.message.trim() : '';
    const positionClass = typeof scene.positionClass === 'string' && scene.positionClass.trim()
        ? scene.positionClass.trim()
        : DEFAULT_CAT_POSITION;
    return { id, ariaLabel, image, message, positionClass };
}

/**
 * Выбрать сцену, избегая повторения предыдущей, если это возможно.
 * @param {Array<{id:string,ariaLabel:string,image:string,message:string,positionClass:string}>} scenes
 */
function selectNextScene(scenes) {
    if (!Array.isArray(scenes) || !scenes.length) {
        return null;
    }

    let availableScenes = scenes;
    try {
        const previousSceneId = sessionStorage.getItem(LAST_SCENE_STORAGE_KEY);
        if (previousSceneId && scenes.length > 1) {
            const filtered = scenes.filter((scene) => scene.id !== previousSceneId);
            if (filtered.length) {
                availableScenes = filtered;
            }
        }
    } catch (storageError) {
        console.warn('Не удалось получить данные из sessionStorage:', storageError);
    }

    const sceneIndex = Math.floor(Math.random() * availableScenes.length);
    const scene = availableScenes[sceneIndex];

    try {
        sessionStorage.setItem(LAST_SCENE_STORAGE_KEY, scene.id);
    } catch (storageError) {
        console.warn('Не удалось сохранить данные в sessionStorage:', storageError);
    }

    return scene;
}

/**
 * Отрисовать сцену с котом, если доступно изображение.
 * @param {HTMLElement} root
 * @param {{id:string,ariaLabel:string,image:string,message:string,positionClass:string}} scene
 */
function renderCatScene(root, scene) {
    const wrapper = document.createElement('div');
    wrapper.className = ['cat-mascot', scene.positionClass].filter(Boolean).join(' ').trim();

    if (scene.image) {
        const imageContainer = document.createElement('div');
        imageContainer.className = 'cat-mascot__image';
        const imageElement = document.createElement('img');
        imageElement.src = scene.image;
        imageElement.alt = scene.ariaLabel;
        imageElement.loading = 'lazy';
        imageElement.decoding = 'async';
        imageElement.className = 'cat-mascot__illustration';
        imageContainer.append(imageElement);
        wrapper.append(imageContainer);
    } else {
        wrapper.classList.add('cat-mascot--text-only');
    }

    const bubble = document.createElement('div');
    bubble.className = 'cat-mascot__bubble';
    bubble.textContent = scene.message;

    wrapper.append(bubble);
    root.innerHTML = '';
    root.append(wrapper);
}

/**
 * Показать текстовый плейсхолдер, если подходящих сцен нет.
 * @param {HTMLElement} root
 */
function renderCatPlaceholder(root) {
    const wrapper = document.createElement('div');
    wrapper.className = ['cat-mascot', 'cat-mascot--text-only', DEFAULT_CAT_POSITION].join(' ');
    const bubble = document.createElement('div');
    bubble.className = 'cat-mascot__bubble';
    bubble.textContent = FALLBACK_CAT_MESSAGE;
    wrapper.append(bubble);
    root.innerHTML = '';
    root.append(wrapper);
}

/**
 * Очистить и нормализовать строки данных.
 * @param {Array<Record<string, unknown>>} rows
 * @returns {Array<Record<string, string>>}
 */
function sanitizeRows(rows) {
    return rows
        .map((row) => {
            const source = row && typeof row === 'object' ? row : {};
            const entries = [];
            for (const [column, value] of Object.entries(source)) {
                const trimmedColumn = typeof column === 'string' ? column.trim() : String(column ?? '').trim();
                if (!trimmedColumn) {
                    continue;
                }
                if (RESERVED_COLUMN_NAMES.has(trimmedColumn.toLowerCase())) {
                    continue;
                }
                const normalizedValue = typeof value === 'string' ? value : String(value ?? '');
                entries.push([trimmedColumn, normalizedValue]);
            }
            return Object.fromEntries(entries);
        })
        .filter((row) => Object.keys(row).length > 0);
}

/**
 * Подготовить обработчики изменения формата файлов и очистки состояния.
 */
function initializeFormatHandling() {
    if (!tableFormatSelect || !fileInputA || !fileInputB) {
        return;
    }
    updateFileInputsAccept(tableFormatSelect.value);
    tableFormatSelect.addEventListener('change', () => {
        updateFileInputsAccept(tableFormatSelect.value);
        clearFilesAfterFormatChange();
        hideError();
        lastDifferences = [];
        lastFileNameA = '';
        lastFileNameB = '';
        lastKeyFieldName = '';
        downloadReportButton.disabled = true;
        downloadDetailedReportButton.disabled = true;
        renderSummary('');
        resetTable();
    });
}

function updateFileInputsAccept(format) {
    if (!fileInputA || !fileInputB) {
        return;
    }
    const formatConfig = TABLE_FORMATS[format] ?? TABLE_FORMATS.csv;
    const acceptValue = Array.isArray(formatConfig.accept) ? formatConfig.accept.join(',') : formatConfig.accept;
    if (acceptValue) {
        fileInputA.setAttribute('accept', acceptValue);
        fileInputB.setAttribute('accept', acceptValue);
    } else {
        fileInputA.removeAttribute('accept');
        fileInputB.removeAttribute('accept');
    }
}

function clearFilesAfterFormatChange() {
    if (fileInputA) {
        fileInputA.value = '';
    }
    if (fileInputB) {
        fileInputB.value = '';
    }
}

function isFileOfFormat(file, formatConfig) {
    const lowerName = file.name.toLowerCase();
    if (formatConfig.extensions.some((extension) => lowerName.endsWith(extension))) {
        return true;
    }
    if (formatConfig === TABLE_FORMATS.csv) {
        return ['text/csv', 'application/vnd.ms-excel'].includes(file.type);
    }
    if (formatConfig === TABLE_FORMATS.txt) {
        return ['text/plain', 'text/csv'].includes(file.type);
    }
    if (formatConfig === TABLE_FORMATS.xlsx) {
        return file.type === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
    }
    if (formatConfig === TABLE_FORMATS.xls) {
        return file.type === 'application/vnd.ms-excel';
    }
    return false;
}

/**
 * Сравнить два набора данных из CSV-файлов.
 * @param {{rows: Array<Record<string, string>>}} datasetA
 * @param {{rows: Array<Record<string, string>>}} datasetB
 * @param {string} keyField
 * @param {string} nameA
 * @param {string} nameB
 */
function compareDatasets(datasetA, datasetB, keyField, nameA, nameB) {
    const rowsA = datasetA.rows;
    const rowsB = datasetB.rows;

    const keyFieldA = resolveKeyField(rowsA, keyField, nameA);
    const keyFieldB = resolveKeyField(rowsB, keyField, nameB);

    if (keyFieldA.toLowerCase() !== keyFieldB.toLowerCase()) {
        throw new Error(`Столбец "${keyField}" найден как "${keyFieldA}" в файле ${nameA} и как "${keyFieldB}" в файле ${nameB}. Убедитесь, что ключевой столбец совпадает.`);
    }

    validateKeysFilled(rowsA, keyFieldA, nameA);
    validateKeysFilled(rowsB, keyFieldB, nameB);

    const duplicatesA = detectDuplicateKeys(rowsA, keyFieldA);
    const duplicatesB = detectDuplicateKeys(rowsB, keyFieldB);

    if (duplicatesA.length || duplicatesB.length) {
        const details = [];
        if (duplicatesA.length) {
            details.push(`Файл ${nameA} содержит дубликаты ключей: ${duplicatesA.join(', ')}`);
        }
        if (duplicatesB.length) {
            details.push(`Файл ${nameB} содержит дубликаты ключей: ${duplicatesB.join(', ')}`);
        }
        throw new Error(details.join('\n'));
    }

    const lookupA = buildLookup(rowsA, keyFieldA);
    const lookupB = buildLookup(rowsB, keyFieldB);
    const allKeys = Array.from(new Set([...Object.keys(lookupA), ...Object.keys(lookupB)])).sort();

    const columnsA = collectColumns(rowsA);
    const columnsB = collectColumns(rowsB);
    const allColumns = Array.from(new Set([...columnsA, ...columnsB])).sort();
    const keyColumns = new Set([keyFieldA, keyFieldB]);

    const differences = [];
    for (const key of allKeys) {
        const rowA = lookupA[key];
        const rowB = lookupB[key];

        if (!rowA) {
            differences.push({
                keyValue: key,
                column: '__missing__',
                value_a: `Нет записи в ${nameA}`,
                value_b: buildRowPreview(rowB, allColumns, keyColumns) || '—',
                difference_type: 'missing_in_a'
            });
            continue;
        }
        if (!rowB) {
            differences.push({
                keyValue: key,
                column: '__missing__',
                value_a: buildRowPreview(rowA, allColumns, keyColumns) || '—',
                value_b: `Нет записи в ${nameB}`,
                difference_type: 'missing_in_b'
            });
            continue;
        }

        for (const column of allColumns) {
            if (keyColumns.has(column)) {
                continue;
            }
            const valueA = (rowA[column] ?? '').trim();
            const valueB = (rowB[column] ?? '').trim();
            if (valueA !== valueB) {
                differences.push({
                    keyValue: key,
                    column,
                    value_a: valueA,
                    value_b: valueB,
                    difference_type: 'value_mismatch'
                });
            }
        }
    }

    const summaryText = buildSummary(differences, nameA, nameB, keyFieldA);
    return {
        differences,
        headers: {
            key: keyFieldA,
            valueA: `Значение ${nameA}`,
            valueB: `Значение ${nameB}`
        },
        summaryText,
        keyField: keyFieldA
    };
}

/**
 * Найти реальное имя ключевого столбца с учётом регистра.
 * @param {Array<Record<string, string>>} rows
 * @param {string} requestedKey
 * @param {string} fileName
 */
function resolveKeyField(rows, requestedKey, fileName) {
    if (!rows.length) {
        throw new Error(`Файл ${fileName} не содержит данных.`);
    }
    const columns = Object.keys(rows[0]);
    if (columns.includes(requestedKey)) {
        return requestedKey;
    }
    const loweredKey = requestedKey.toLowerCase();
    const matchedColumn = columns.find((column) => column.toLowerCase() === loweredKey);
    if (matchedColumn) {
        return matchedColumn;
    }
    throw new Error(`В файле ${fileName} отсутствует столбец "${requestedKey}". Доступные поля: ${columns.join(', ')}.`);
}

function validateKeysFilled(rows, keyField, fileName) {
    const emptyRows = [];
    rows.forEach((row, index) => {
        const normalizedKey = normalizeKeyValue(row[keyField]);
        if (!normalizedKey) {
            emptyRows.push(index + 1);
        }
    });
    if (emptyRows.length) {
        throw new Error(`В файле ${fileName} обнаружены строки без значения в столбце "${keyField}" (например, строки: ${emptyRows.slice(0, 5).join(', ')}).`);
    }
}

/**
 * Собрать множество столбцов.
 * @param {Array<Record<string, string>>} rows
 * @returns {Set<string>}
 */
function collectColumns(rows) {
    const columns = new Set();
    for (const row of rows) {
        Object.keys(row).forEach((key) => {
            const trimmedKey = key.trim();
            if (trimmedKey) {
                columns.add(trimmedKey);
            }
        });
    }
    return columns;
}

/**
 * Создать словарь строк по ключевому столбцу.
 * @param {Array<Record<string, string>>} rows
 * @param {string} keyField
 */
function buildLookup(rows, keyField) {
    const map = Object.create(null);
    for (const row of rows) {
        const key = normalizeKeyValue(row[keyField]);
        if (key) {
            map[key] = row;
        }
    }
    return map;
}

/**
 * Найти дубликаты ключей.
 * @param {Array<Record<string, string>>} rows
 * @param {string} keyField
 * @returns {string[]}
 */
function detectDuplicateKeys(rows, keyField) {
    const seen = new Map();
    const duplicates = new Set();
    for (const row of rows) {
        const key = normalizeKeyValue(row[keyField]);
        const count = (seen.get(key) ?? 0) + 1;
        seen.set(key, count);
        if (count > 1) {
            duplicates.add(key);
        }
    }
    return Array.from(duplicates).filter(Boolean).sort();
}

/**
 * Сформировать короткое описание строки.
 * @param {Record<string, string>} row
 * @param {string[]} columns
 * @param {Set<string>} keyColumns
 */
function buildRowPreview(row, columns, keyColumns) {
    if (!row) {
        return '';
    }
    const parts = [];
    for (const column of columns) {
        if (keyColumns.has(column)) {
            continue;
        }
        const value = (row[column] ?? '').trim();
        if (value) {
            parts.push(`${column}=${value}`);
        }
    }
    return parts.join(', ');
}

/**
 * Построить текстовую сводку различий.
 * @param {Array<Record<string, string>>} differences
 * @param {string} nameA
 * @param {string} nameB
 */
function buildSummary(differences, nameA, nameB, keyField) {
    if (!differences.length) {
        return `Различий не обнаружено. Файл 1: ${nameA}. Файл 2: ${nameB}. Ключ: ${keyField}.`;
    }
    const counts = differences.reduce((acc, diff) => {
        acc[diff.difference_type] = (acc[diff.difference_type] ?? 0) + 1;
        return acc;
    }, {});
    const details = [];
    if (counts['value_mismatch']) {
        details.push(`несовпадений значений — ${counts['value_mismatch']}`);
    }
    if (counts['missing_in_a']) {
        details.push(`нет строк в файле 1 — ${counts['missing_in_a']}`);
    }
    if (counts['missing_in_b']) {
        details.push(`нет строк в файле 2 — ${counts['missing_in_b']}`);
    }
    const detailsText = details.length ? ` Детализация: ${details.join('; ')}.` : '';
    return `Всего различий: ${differences.length}. Файл 1: ${nameA}. Файл 2: ${nameB}. Ключ: ${keyField}.${detailsText}`;
}

/**
 * Построить табличные данные для сводного отчёта по полям.
 * @param {Array<Record<string, string>>} differences
 */
function buildAggregatedReportData(differences) {
    if (!differences.length) {
        throw new Error('Отчёт нельзя сохранить: различия отсутствуют.');
    }
    const counter = new Map();
    for (const diff of differences) {
        const fieldName = diff.column === '__missing__' ? 'Строка отсутствует' : diff.column;
        const current = counter.get(fieldName) ?? { total: 0, mismatch: 0, missingA: 0, missingB: 0 };
        current.total += 1;
        if (diff.difference_type === 'value_mismatch') {
            current.mismatch += 1;
        } else if (diff.difference_type === 'missing_in_a') {
            current.missingA += 1;
        } else if (diff.difference_type === 'missing_in_b') {
            current.missingB += 1;
        }
        counter.set(fieldName, current);
    }
    const rows = [[
        'Поле',
        'Всего расхождений',
        'Несовпадений значений',
        'Отсутствует в файле 1',
        'Отсутствует в файле 2'
    ]];
    const sortedFields = Array.from(counter.keys()).sort();
    for (const field of sortedFields) {
        const { total, mismatch, missingA, missingB } = counter.get(field);
        rows.push([
            field,
            String(total),
            String(mismatch),
            String(missingA),
            String(missingB)
        ]);
    }
    return rows;
}

/**
 * Построить табличные данные подробного отчёта, повторяющего таблицу различий.
 * @param {Array<Record<string, string>>} differences
 * @param {string} nameA
 * @param {string} nameB
 * @param {string} keyField
 */
function buildDetailedReportData(differences, nameA, nameB, keyField) {
    if (!differences.length) {
        throw new Error('Отчёт нельзя сохранить: различия отсутствуют.');
    }

    const effectiveKeyField = keyField || DEFAULT_KEY_HEADER;

    const rows = [[
        effectiveKeyField,
        'Поле',
        'Тип различия',
        `Значение ${nameA}`,
        `Значение ${nameB}`
    ]];

    for (const diff of differences) {
        const fieldName = diff.column === '__missing__' ? 'Строка отсутствует' : diff.column;
        const typeLabel = labelForDifference(diff.difference_type);
        const valueA = diff.value_a || '—';
        const valueB = diff.value_b || '—';
        rows.push([
            diff.keyValue,
            fieldName,
            typeLabel,
            valueA,
            valueB
        ]);
    }

    return rows;
}

/**
 * Экранировать значение для CSV.
 * @param {string|number} value
 */
function escapeCsvValue(value) {
    const stringValue = String(value ?? '');
    if (/[",\n]/.test(stringValue)) {
        return `"${stringValue.replace(/"/g, '""')}"`;
    }
    return stringValue;
}

/**
 * Показать результаты сравнения в таблице.
 * @param {Array<Record<string, string>>} differences
 * @param {{valueA: string, valueB: string}} headers
 */
function renderDifferences(differences, headers) {
    if (!tableBody || !keyHeader || !valueHeaderA || !valueHeaderB) {
        return;
    }
    tableBody.innerHTML = '';
    keyHeader.textContent = headers.key || DEFAULT_KEY_HEADER;
    valueHeaderA.textContent = headers.valueA;
    valueHeaderB.textContent = headers.valueB;

    if (!differences.length) {
        const row = document.createElement('tr');
        row.classList.add('empty-state');
        const cell = document.createElement('td');
        cell.colSpan = 5;
        cell.textContent = 'Различий не обнаружено.';
        row.appendChild(cell);
        tableBody.appendChild(row);
        return;
    }

    const fragment = document.createDocumentFragment();
    for (const diff of differences) {
        const row = document.createElement('tr');
        row.classList.add('result');
        const rowClass = classForDifference(diff.difference_type);
        if (rowClass) {
            row.classList.add(rowClass);
        }

        const policyCell = document.createElement('td');
        policyCell.textContent = diff.keyValue;
        row.appendChild(policyCell);

        const columnCell = document.createElement('td');
        columnCell.textContent = diff.column === '__missing__' ? 'Строка отсутствует' : diff.column;
        row.appendChild(columnCell);

        const typeCell = document.createElement('td');
        typeCell.textContent = labelForDifference(diff.difference_type);
        row.appendChild(typeCell);

        const valueACell = document.createElement('td');
        valueACell.textContent = diff.value_a || '—';
        row.appendChild(valueACell);

        const valueBCell = document.createElement('td');
        valueBCell.textContent = diff.value_b || '—';
        row.appendChild(valueBCell);

        fragment.appendChild(row);
    }
    tableBody.appendChild(fragment);
}

/**
 * Получить CSS-класс по типу различия.
 * @param {string} differenceType
 */
function classForDifference(differenceType) {
    if (differenceType === 'value_mismatch') {
        return 'result--mismatch';
    }
    if (differenceType === 'missing_in_a') {
        return 'result--missing-a';
    }
    if (differenceType === 'missing_in_b') {
        return 'result--missing-b';
    }
    return '';
}

/**
 * Получить текстовую метку различия.
 * @param {string} differenceType
 */
function labelForDifference(differenceType) {
    if (differenceType === 'value_mismatch') {
        return 'Несовпадение значений';
    }
    if (differenceType === 'missing_in_a') {
        return 'Нет строки в файле 1';
    }
    if (differenceType === 'missing_in_b') {
        return 'Нет строки в файле 2';
    }
    return 'Различие';
}

function renderSummary(text) {
    if (!summaryBlock) {
        return;
    }
    if (!text) {
        summaryBlock.hidden = true;
        summaryBlock.textContent = '';
        return;
    }
    summaryBlock.hidden = false;
    summaryBlock.textContent = text;
}

function resetTable() {
    if (!tableBody || !keyHeader || !valueHeaderA || !valueHeaderB) {
        return;
    }
    tableBody.innerHTML = '';
    const row = document.createElement('tr');
    row.classList.add('empty-state');
    const cell = document.createElement('td');
    cell.colSpan = 5;
    cell.textContent = 'Загрузите файлы и нажмите «Сравнить», чтобы увидеть различия.';
    row.appendChild(cell);
    tableBody.appendChild(row);
    keyHeader.textContent = lastKeyFieldName || DEFAULT_KEY_HEADER;
    valueHeaderA.textContent = 'Значение файла 1';
    valueHeaderB.textContent = 'Значение файла 2';
}

function showError(message) {
    if (!errorBlock) {
        return;
    }
    errorBlock.hidden = false;
    errorBlock.textContent = message;
}

function hideError() {
    if (!errorBlock) {
        return;
    }
    errorBlock.hidden = true;
    errorBlock.textContent = '';
}

function showLoadingIndicator() {
    if (!loadingIndicator) {
        return;
    }
    loadingIndicator.hidden = false;
    loadingIndicator.setAttribute('aria-busy', 'true');
}

function hideLoadingIndicator() {
    if (!loadingIndicator) {
        return;
    }
    loadingIndicator.hidden = true;
    loadingIndicator.removeAttribute('aria-busy');
}

function normalizeKeyValue(value) {
    return typeof value === 'string' ? value.trim() : String(value ?? '').trim();
}

// Пример использования функций сравнения в изолированном режиме (для тестирования в консоли браузера).
// runQuickCheck();
function runQuickCheck() {
    const datasetA = { rows: [
        { POLICY_NO: '1', Amount: '100', Status: 'Active' },
        { POLICY_NO: '2', Amount: '150', Status: 'Pending' }
    ] };
    const datasetB = { rows: [
        { POLICY_NO: '1', Amount: '120', Status: 'Active' },
        { POLICY_NO: '3', Amount: '200', Status: 'Closed' }
    ] };
    console.log(compareDatasets(datasetA, datasetB, 'POLICY_NO', 'A.csv', 'B.csv'));
}

export {
    buildAggregatedReportData,
    buildDetailedReportData,
    buildSummary,
    compareDatasets,
    convertRowsToCsv,
    convertRowsToTxt,
    detectDuplicateKeys,
    escapeCsvValue,
    hasMeaningfulColumnStructure,
    isUndetectableDelimiterError,
    normalizeKeyValue,
    selectDelimiterFromSample,
    resolveKeyField,
    sanitizeFilename,
    sanitizeRows,
    shouldRetryWithFallbackDelimiter
};
