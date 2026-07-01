const BURNED_PRACTICE_KEY = 'wanikani_burned_practice_progress_v1';

function subjectIdForAssignment(assignment) {
    return assignment?.data?.subject_id ? String(assignment.data.subject_id) : null;
}

function uniqueSubjectIds(assignments) {
    return new Set(assignments.map(subjectIdForAssignment).filter(Boolean));
}

function shuffleInPlace(array) {
    for (let i = array.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [array[i], array[j]] = [array[j], array[i]];
    }
    return array;
}

export class BurnedPracticeStore {
    constructor(storage = localStorage) {
        this.storage = storage;
        this.state = this.load();
    }

    load() {
        try {
            const parsed = JSON.parse(this.storage.getItem(BURNED_PRACTICE_KEY) || '{}');
            return {
                completedSubjectIds: new Set(parsed.completedSubjectIds || []),
                missedSubjectIds: new Set(parsed.missedSubjectIds || []),
                attemptsBySubjectId: parsed.attemptsBySubjectId || {},
                cycleStartedAt: parsed.cycleStartedAt || new Date().toISOString()
            };
        } catch (error) {
            console.warn('Failed to load burned practice progress:', error);
            return this.createEmptyState();
        }
    }

    createEmptyState() {
        return {
            completedSubjectIds: new Set(),
            missedSubjectIds: new Set(),
            attemptsBySubjectId: {},
            cycleStartedAt: new Date().toISOString()
        };
    }

    persist() {
        const payload = {
            completedSubjectIds: [...this.state.completedSubjectIds],
            missedSubjectIds: [...this.state.missedSubjectIds],
            attemptsBySubjectId: this.state.attemptsBySubjectId,
            cycleStartedAt: this.state.cycleStartedAt
        };

        this.storage.setItem(BURNED_PRACTICE_KEY, JSON.stringify(payload));
    }

    resetCycle() {
        this.state.completedSubjectIds.clear();
        this.state.missedSubjectIds.clear();
        this.state.cycleStartedAt = new Date().toISOString();
        this.persist();
    }

    isCycleExhausted(assignments) {
        const availableSubjectIds = uniqueSubjectIds(assignments);
        if (availableSubjectIds.size === 0 || this.state.missedSubjectIds.size > 0) {
            return false;
        }

        for (const subjectId of availableSubjectIds) {
            if (!this.state.completedSubjectIds.has(subjectId)) {
                return false;
            }
        }

        return true;
    }

    selectAssignments(assignments, limit) {
        if (this.isCycleExhausted(assignments)) {
            this.resetCycle();
        }

        const missed = [];
        const uncompleted = [];

        for (const assignment of assignments) {
            const subjectId = subjectIdForAssignment(assignment);
            if (!subjectId) {
                continue;
            }

            if (this.state.missedSubjectIds.has(subjectId)) {
                missed.push(assignment);
            } else if (!this.state.completedSubjectIds.has(subjectId)) {
                uncompleted.push(assignment);
            }
        }

        const ordered = [
            ...shuffleInPlace(missed),
            ...shuffleInPlace(uncompleted)
        ];

        return ordered.slice(0, limit);
    }

    recordAttempt({ subjectId, isCorrect, modeId, incorrectMeaningCount = 0, incorrectReadingCount = 0 }) {
        if (!subjectId) {
            return;
        }

        const key = String(subjectId);
        const now = new Date().toISOString();
        const previous = this.state.attemptsBySubjectId[key] || {
            attempts: 0,
            correct: 0,
            incorrect: 0
        };

        const next = {
            ...previous,
            attempts: previous.attempts + 1,
            correct: previous.correct + (isCorrect ? 1 : 0),
            incorrect: previous.incorrect + (isCorrect ? 0 : 1),
            lastPracticedAt: now,
            lastModeId: modeId,
            lastIncorrectMeaningCount: incorrectMeaningCount,
            lastIncorrectReadingCount: incorrectReadingCount
        };

        this.state.attemptsBySubjectId[key] = next;

        if (isCorrect) {
            this.state.missedSubjectIds.delete(key);
            this.state.completedSubjectIds.add(key);
        } else {
            this.state.completedSubjectIds.delete(key);
            this.state.missedSubjectIds.add(key);
        }

        this.persist();
    }
}
