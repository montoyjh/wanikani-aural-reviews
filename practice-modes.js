export const PRACTICE_MODES = {
    dueReviews: {
        id: 'dueReviews',
        label: 'Due Reviews',
        source: 'dueAssignments',
        submitToWanikani: true,
        itemLimit: 100,
        questionTypes: ['meaning', 'reading']
    },
    burnedPractice: {
        id: 'burnedPractice',
        label: 'Burned Practice',
        source: 'burnedAssignments',
        submitToWanikani: false,
        itemLimit: 50,
        poolLimit: Infinity,
        subjectTypes: ['kanji', 'vocabulary'],
        questionTypes: ['meaning', 'reading']
    },
    dueReviewsWithBurned: {
        id: 'dueReviewsWithBurned',
        label: 'Due Reviews + Burned Warmups',
        source: 'dueAssignmentsWithBurnedPractice',
        submitToWanikani: true,
        itemLimit: 100,
        burnedPracticeCount: 5,
        questionTypes: ['meaning', 'reading']
    },
    visuallySimilarKanji: {
        id: 'visuallySimilarKanji',
        label: 'Visually Similar Kanji',
        source: 'visuallySimilarKanji',
        submitToWanikani: false,
        itemLimit: 50,
        poolLimit: 300,
        subjectTypes: ['kanji'],
        questionTypes: ['meaning', 'reading']
    },
    similarMeaningWords: {
        id: 'similarMeaningWords',
        label: 'Similar Meaning Words',
        source: 'similarMeaningWords',
        submitToWanikani: false,
        itemLimit: 50,
        poolLimit: 300,
        subjectTypes: ['vocabulary'],
        questionTypes: ['meaning', 'reading']
    }
};

export const DEFAULT_PRACTICE_MODE_ID = 'dueReviews';

export function getPracticeMode(modeId) {
    return PRACTICE_MODES[modeId] || PRACTICE_MODES[DEFAULT_PRACTICE_MODE_ID];
}

function shuffleInPlace(array) {
    for (let i = array.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [array[i], array[j]] = [array[j], array[i]];
    }
    return array;
}

function interleavePracticeItems(reviewItems, practiceItems) {
    if (practiceItems.length === 0) {
        return reviewItems;
    }

    const interleaved = [...reviewItems];
    const spacing = Math.max(1, Math.floor(interleaved.length / practiceItems.length));

    practiceItems.forEach((item, index) => {
        const insertAt = Math.min(interleaved.length, (index + 1) * spacing + index);
        interleaved.splice(insertAt, 0, item);
    });

    return interleaved;
}

function toSessionItem(assignment, mode, overrides = {}) {
    return {
        assignment,
        assignmentId: assignment.id,
        subjectId: assignment.data.subject_id,
        submitToWanikani: mode.submitToWanikani,
        questionTypes: [...mode.questionTypes],
        modeId: mode.id,
        ...overrides
    };
}

function normalizeMeaning(meaning) {
    return meaning
        .normalize('NFKC')
        .toLowerCase()
        .replace(/[^a-z0-9\s-]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

function acceptedMeanings(subject) {
    return subject.meanings
        ? subject.meanings.filter((meaning) => meaning.accepted_answer).map((meaning) => meaning.meaning)
        : [];
}

function flattenGroups(groups, mode, assignmentBySubjectId) {
    const selectedItems = [];
    let groupNumber = 0;

    for (const group of shuffleInPlace(groups)) {
        const assignments = shuffleInPlace(
            group.subjectIds
                .map((subjectId) => assignmentBySubjectId.get(subjectId))
                .filter(Boolean)
        );

        if (assignments.length < 2) {
            continue;
        }

        groupNumber++;
        const groupId = `${mode.id}-${groupNumber}`;

        assignments.forEach((assignment, index) => {
            selectedItems.push(toSessionItem(assignment, mode, {
                submitToWanikani: false,
                groupId,
                groupLabel: group.label,
                groupPosition: index + 1,
                groupSize: assignments.length
            }));
        });

        if (selectedItems.length >= mode.itemLimit) {
            break;
        }
    }

    return selectedItems;
}

async function loadDueAssignments(apiClient, mode, reviewOrder) {
    let assignments = await apiClient.getAssignments('immediately_available_for_review=true', {
        limit: mode.itemLimit
    });

    if (reviewOrder !== 'sequential') {
        assignments = shuffleInPlace(assignments);
    }

    return assignments.map((assignment) => toSessionItem(assignment, mode));
}

async function loadBurnedAssignments(apiClient, mode, burnedPracticeStore) {
    const subjectTypes = mode.subjectTypes || ['kanji', 'vocabulary'];
    const query = `srs_stages=9&subject_types=${subjectTypes.join(',')}`;
    const assignments = await apiClient.getAssignments(query, {
        limit: mode.poolLimit || mode.itemLimit
    });

    const eligibleAssignments = assignments
        .filter((assignment) => assignment.data?.subject_type !== 'radical');
    const selectedEntries = burnedPracticeStore
        ? burnedPracticeStore.selectAssignmentEntries(eligibleAssignments, mode.itemLimit)
        : shuffleInPlace(eligibleAssignments)
            .slice(0, mode.itemLimit)
            .map((assignment) => ({ assignment, phase: 'fullPass' }));

    return selectedEntries
        .map(({ assignment, phase }) => toSessionItem(assignment, mode, {
            submitToWanikani: false,
            burnedPracticePhase: phase
        }));
}

async function loadGroupedBurnedAssignments(apiClient, subjectStore, mode, burnedPracticeStore, groupBuilder) {
    if (!subjectStore) {
        throw new Error(`${mode.label} requires a subject store`);
    }

    const subjectTypes = mode.subjectTypes || ['kanji', 'vocabulary'];
    const query = `srs_stages=9&subject_types=${subjectTypes.join(',')}`;
    const assignments = await apiClient.getAssignments(query, {
        limit: mode.poolLimit || mode.itemLimit
    });
    const eligibleAssignments = assignments
        .filter((assignment) => assignment.data?.subject_type !== 'radical');
    const selectedEntries = burnedPracticeStore
        ? burnedPracticeStore.selectAssignmentEntries(eligibleAssignments, mode.poolLimit || mode.itemLimit)
        : shuffleInPlace(eligibleAssignments)
            .slice(0, mode.poolLimit || mode.itemLimit)
            .map((assignment) => ({ assignment, phase: 'fullPass' }));
    const selectedAssignments = selectedEntries.map(({ assignment }) => assignment);
    const phaseBySubjectId = new Map(
        selectedEntries.map(({ assignment, phase }) => [assignment.data.subject_id, phase])
    );
    const subjects = await subjectStore.getSubjects(selectedAssignments.map((assignment) => assignment.data.subject_id));
    const assignmentBySubjectId = new Map(
        selectedAssignments.map((assignment) => [assignment.data.subject_id, assignment])
    );
    const subjectById = new Map(subjects.map((subject) => [subject.id, subject]));
    const groups = groupBuilder(subjects, subjectById, assignmentBySubjectId);

    return flattenGroups(groups, mode, assignmentBySubjectId)
        .map((item) => ({
            ...item,
            burnedPracticePhase: phaseBySubjectId.get(item.subjectId) || 'fullPass'
        }));
}

function buildVisuallySimilarGroups(subjects, subjectById, assignmentBySubjectId) {
    const groupsByKey = new Map();

    for (const subject of subjects) {
        if (subject.object !== 'kanji' || !Array.isArray(subject.visually_similar_subject_ids)) {
            continue;
        }

        const subjectIds = [
            subject.id,
            ...subject.visually_similar_subject_ids
        ].filter((subjectId) => assignmentBySubjectId.has(subjectId));
        const uniqueSubjectIds = [...new Set(subjectIds)].sort((left, right) => left - right);

        if (uniqueSubjectIds.length < 2) {
            continue;
        }

        const key = uniqueSubjectIds.join(',');
        if (!groupsByKey.has(key)) {
            const label = uniqueSubjectIds
                .map((subjectId) => subjectById.get(subjectId)?.characters)
                .filter(Boolean)
                .join(' / ');
            groupsByKey.set(key, { label, subjectIds: uniqueSubjectIds });
        }
    }

    return [...groupsByKey.values()];
}

function buildSimilarMeaningGroups(subjects) {
    const groupsByMeaning = new Map();

    for (const subject of subjects) {
        if (subject.object !== 'vocabulary') {
            continue;
        }

        for (const meaning of acceptedMeanings(subject)) {
            const key = normalizeMeaning(meaning);
            if (!key) {
                continue;
            }

            if (!groupsByMeaning.has(key)) {
                groupsByMeaning.set(key, { label: meaning, subjectIds: [] });
            }

            groupsByMeaning.get(key).subjectIds.push(subject.id);
        }
    }

    return [...groupsByMeaning.values()]
        .map((group) => ({
            ...group,
            subjectIds: [...new Set(group.subjectIds)]
        }))
        .filter((group) => group.subjectIds.length > 1);
}

export async function buildPracticeSession({ apiClient, subjectStore = null, mode, reviewOrder = 'random', burnedPracticeStore = null }) {
    let items = [];
    let totalAvailableItems = 0;
    let burnedPracticeProgress = null;

    if (mode.source === 'dueAssignments') {
        items = await loadDueAssignments(apiClient, mode, reviewOrder);
        totalAvailableItems = items.length;
    } else if (mode.source === 'burnedAssignments') {
        items = await loadBurnedAssignments(apiClient, mode, burnedPracticeStore);
        burnedPracticeProgress = burnedPracticeStore?.getProgressSnapshot() || null;
        totalAvailableItems = burnedPracticeProgress?.fullPassTotal || items.length;
    } else if (mode.source === 'dueAssignmentsWithBurnedPractice') {
        const dueItems = await loadDueAssignments(apiClient, mode, reviewOrder);
        const burnedMode = {
            ...PRACTICE_MODES.burnedPractice,
            itemLimit: mode.burnedPracticeCount || 0,
            poolLimit: mode.burnedPracticePoolLimit || 300
        };
        const burnedItems = await loadBurnedAssignments(apiClient, burnedMode, burnedPracticeStore);
        items = interleavePracticeItems(dueItems, burnedItems);
        totalAvailableItems = dueItems.length;
    } else if (mode.source === 'visuallySimilarKanji') {
        items = await loadGroupedBurnedAssignments(
            apiClient,
            subjectStore,
            mode,
            burnedPracticeStore,
            buildVisuallySimilarGroups
        );
        totalAvailableItems = items.length;
    } else if (mode.source === 'similarMeaningWords') {
        items = await loadGroupedBurnedAssignments(
            apiClient,
            subjectStore,
            mode,
            burnedPracticeStore,
            buildSimilarMeaningGroups
        );
        totalAvailableItems = items.length;
    } else {
        throw new Error(`Unsupported practice mode source: ${mode.source}`);
    }

    return {
        mode,
        items,
        totalAvailableItems,
        burnedPracticeProgress,
        index: 0,
        stats: {
            completed: 0,
            submitted: 0,
            practiceOnly: items.filter((item) => !item.submitToWanikani).length
        }
    };
}
