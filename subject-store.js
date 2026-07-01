const SUBJECT_CACHE_KEY = 'wanikani_subject_cache_v1';
const SUBJECT_CACHE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

function now() {
    return Date.now();
}

function subjectReadings(subject) {
    return subject.readings
        ? subject.readings.filter((reading) => reading.accepted_answer).map((reading) => reading.reading)
        : [];
}

function subjectMeanings(subject) {
    return subject.meanings
        ? subject.meanings.filter((meaning) => meaning.accepted_answer).map((meaning) => meaning.meaning)
        : [];
}

export class SubjectStore {
    constructor(apiClient, storage = localStorage) {
        this.apiClient = apiClient;
        this.storage = storage;
        this.subjectsById = new Map();
        this.kanjiData = new Map();
        this.vocabularyData = new Map();
        this.loadFromStorage();
    }

    loadFromStorage() {
        try {
            const cached = JSON.parse(this.storage.getItem(SUBJECT_CACHE_KEY) || '[]');
            const cutoff = now() - SUBJECT_CACHE_MAX_AGE_MS;

            for (const entry of cached) {
                if (!entry?.id || !entry?.subject || entry.cachedAt < cutoff) {
                    continue;
                }

                this.subjectsById.set(entry.id, entry.subject);
                this.indexSubject(entry.subject);
            }
        } catch (error) {
            console.warn('Failed to restore subject cache:', error);
            this.subjectsById.clear();
            this.kanjiData.clear();
            this.vocabularyData.clear();
        }
    }

    persist() {
        try {
            const payload = [...this.subjectsById.entries()].map(([id, subject]) => ({
                id,
                subject,
                cachedAt: subject._cachedAt || now()
            }));
            this.storage.setItem(SUBJECT_CACHE_KEY, JSON.stringify(payload));
        } catch (error) {
            console.warn('Failed to persist subject cache:', error);
        }
    }

    indexSubject(subject) {
        if (!subject) {
            return;
        }

        const key = subject.characters || subject.slug;
        if (!key) {
            return;
        }

        const value = {
            readings: subjectReadings(subject),
            meanings: subjectMeanings(subject)
        };

        if (subject.object === 'kanji') {
            this.kanjiData.set(key, value);
        } else if (subject.object === 'vocabulary') {
            this.vocabularyData.set(key, value);
        }
    }

    async getSubject(subjectId) {
        if (this.subjectsById.has(subjectId)) {
            return this.subjectsById.get(subjectId);
        }

        const subject = await this.apiClient.getSubject(subjectId);
        subject._cachedAt = now();
        this.subjectsById.set(subjectId, subject);
        this.indexSubject(subject);
        this.persist();
        return subject;
    }

    async getSubjects(subjectIds) {
        const uniqueIds = [...new Set(subjectIds)].filter(Boolean);
        const missingIds = uniqueIds.filter((subjectId) => !this.subjectsById.has(subjectId));

        if (missingIds.length > 0) {
            const subjects = await this.apiClient.getSubjectsByIds(missingIds);
            const cachedAt = now();

            for (const subject of subjects) {
                subject._cachedAt = cachedAt;
                this.subjectsById.set(subject.id, subject);
                this.indexSubject(subject);
            }

            this.persist();
        }

        return uniqueIds
            .map((subjectId) => this.subjectsById.get(subjectId))
            .filter(Boolean);
    }

    async prefetchSubjects(subjectIds) {
        try {
            await this.getSubjects(subjectIds);
        } catch (error) {
            console.warn('Failed to prefetch subjects:', error);
        }
    }

    getKanjiData() {
        return this.kanjiData;
    }

    getVocabularyData() {
        return this.vocabularyData;
    }

    clear() {
        this.subjectsById.clear();
        this.kanjiData.clear();
        this.vocabularyData.clear();
        this.storage.removeItem(SUBJECT_CACHE_KEY);
    }
}
