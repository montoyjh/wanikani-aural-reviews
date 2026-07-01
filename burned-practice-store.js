const BURNED_PRACTICE_KEY = 'wanikani_burned_practice_progress_v1';

function subjectIdForAssignment(assignment) {
    return assignment?.data?.subject_id ? String(assignment.data.subject_id) : null;
}

function uniqueSubjectIds(assignments) {
    return new Set(assignments.map(subjectIdForAssignment).filter(Boolean));
}

function retryEntries(retryReviewCountsBySubjectId) {
    return Object.entries(retryReviewCountsBySubjectId)
        .filter(([, remaining]) => Number.isFinite(remaining) && remaining > 0);
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
            const legacyMissedSubjectIds = parsed.missedSubjectIds || [];
            const retryReviewCountsBySubjectId = parsed.retryReviewCountsBySubjectId || Object.fromEntries(
                legacyMissedSubjectIds.map((subjectId) => [String(subjectId), 3])
            );

            return {
                fullPassCompletedSubjectIds: new Set(parsed.fullPassCompletedSubjectIds || parsed.completedSubjectIds || []),
                fullPassOrderSubjectIds: parsed.fullPassOrderSubjectIds || [],
                retryReviewCountsBySubjectId,
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
            fullPassCompletedSubjectIds: new Set(),
            fullPassOrderSubjectIds: [],
            retryReviewCountsBySubjectId: {},
            attemptsBySubjectId: {},
            cycleStartedAt: new Date().toISOString()
        };
    }

    persist() {
        const payload = {
            fullPassCompletedSubjectIds: [...this.state.fullPassCompletedSubjectIds],
            fullPassOrderSubjectIds: this.state.fullPassOrderSubjectIds,
            retryReviewCountsBySubjectId: this.state.retryReviewCountsBySubjectId,
            attemptsBySubjectId: this.state.attemptsBySubjectId,
            cycleStartedAt: this.state.cycleStartedAt
        };

        this.storage.setItem(BURNED_PRACTICE_KEY, JSON.stringify(payload));
    }

    resetCycle(assignments = []) {
        this.state.fullPassCompletedSubjectIds.clear();
        this.state.fullPassOrderSubjectIds = shuffleInPlace([...uniqueSubjectIds(assignments)]);
        this.state.retryReviewCountsBySubjectId = {};
        this.state.cycleStartedAt = new Date().toISOString();
        this.persist();
    }

    isCycleExhausted(assignments) {
        const availableSubjectIds = uniqueSubjectIds(assignments);
        if (availableSubjectIds.size === 0 || retryEntries(this.state.retryReviewCountsBySubjectId).length > 0) {
            return false;
        }

        for (const subjectId of availableSubjectIds) {
            if (!this.state.fullPassCompletedSubjectIds.has(subjectId)) {
                return false;
            }
        }

        return true;
    }

    syncAssignmentPool(assignments) {
        const assignmentBySubjectId = new Map();
        for (const assignment of assignments) {
            const subjectId = subjectIdForAssignment(assignment);
            if (subjectId && !assignmentBySubjectId.has(subjectId)) {
                assignmentBySubjectId.set(subjectId, assignment);
            }
        }

        const availableSubjectIds = new Set(assignmentBySubjectId.keys());
        const order = this.state.fullPassOrderSubjectIds
            .map(String)
            .filter((subjectId) => availableSubjectIds.has(subjectId));
        const orderedSubjectIds = new Set(order);
        const newSubjectIds = [...availableSubjectIds].filter((subjectId) => !orderedSubjectIds.has(subjectId));

        if (newSubjectIds.length > 0) {
            order.push(...shuffleInPlace(newSubjectIds));
        }

        this.state.fullPassOrderSubjectIds = order;
        this.state.fullPassCompletedSubjectIds = new Set(
            [...this.state.fullPassCompletedSubjectIds].filter((subjectId) => availableSubjectIds.has(subjectId))
        );
        this.state.retryReviewCountsBySubjectId = Object.fromEntries(
            retryEntries(this.state.retryReviewCountsBySubjectId)
                .filter(([subjectId]) => availableSubjectIds.has(subjectId))
        );

        return assignmentBySubjectId;
    }

    isFullPassComplete() {
        return this.state.fullPassOrderSubjectIds.length > 0 &&
            this.state.fullPassOrderSubjectIds.every((subjectId) => this.state.fullPassCompletedSubjectIds.has(subjectId));
    }

    getProgressSnapshot() {
        const fullPassTotal = this.state.fullPassOrderSubjectIds.length;
        const fullPassCompleted = this.state.fullPassOrderSubjectIds
            .filter((subjectId) => this.state.fullPassCompletedSubjectIds.has(subjectId))
            .length;
        const retries = retryEntries(this.state.retryReviewCountsBySubjectId);
        const retryReviewsRemaining = retries
            .reduce((total, [, remaining]) => total + remaining, 0);

        return {
            phase: fullPassTotal > 0 && fullPassCompleted >= fullPassTotal ? 'retry' : 'fullPass',
            fullPassCompleted,
            fullPassTotal,
            retrySubjectCount: retries.length,
            retryReviewsRemaining
        };
    }

    selectAssignmentEntries(assignments, limit) {
        let assignmentBySubjectId = this.syncAssignmentPool(assignments);

        if (this.isCycleExhausted(assignments)) {
            this.resetCycle(assignments);
            assignmentBySubjectId = this.syncAssignmentPool(assignments);
        }

        if (!this.isFullPassComplete()) {
            return this.state.fullPassOrderSubjectIds
                .filter((subjectId) => !this.state.fullPassCompletedSubjectIds.has(subjectId))
                .map((subjectId) => assignmentBySubjectId.get(subjectId))
                .filter(Boolean)
                .slice(0, limit)
                .map((assignment) => ({ assignment, phase: 'fullPass' }));
        }

        const retryAssignments = [];
        for (const [subjectId, remaining] of retryEntries(this.state.retryReviewCountsBySubjectId)) {
            const assignment = assignmentBySubjectId.get(subjectId);
            if (!assignment) {
                continue;
            }

            for (let count = 0; count < remaining; count++) {
                retryAssignments.push({ assignment, phase: 'retry' });
            }
        }

        return shuffleInPlace(retryAssignments).slice(0, limit);
    }

    selectAssignments(assignments, limit) {
        return this.selectAssignmentEntries(assignments, limit).map(({ assignment }) => assignment);
    }

    recordAttempt({ subjectId, isCorrect, modeId, reviewPhase = 'fullPass', incorrectMeaningCount = 0, incorrectReadingCount = 0 }) {
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

        if (reviewPhase === 'retry') {
            const previousRemaining = this.state.retryReviewCountsBySubjectId[key] || 0;
            const nextRemaining = isCorrect ? previousRemaining - 1 : previousRemaining + 2;

            if (nextRemaining > 0) {
                this.state.retryReviewCountsBySubjectId[key] = nextRemaining;
            } else {
                delete this.state.retryReviewCountsBySubjectId[key];
            }
        } else {
            this.state.fullPassCompletedSubjectIds.add(key);
            if (!isCorrect) {
                this.state.retryReviewCountsBySubjectId[key] =
                    (this.state.retryReviewCountsBySubjectId[key] || 0) + 3;
            }
        }

        this.persist();
    }
}
