const WANIKANI_REVISION = '20170710';
const API_BASE_URL = 'https://api.wanikani.com/v2';

export class WanikaniApiClient {
    constructor(apiToken) {
        this.apiToken = apiToken;
    }

    setApiToken(apiToken) {
        this.apiToken = apiToken;
    }

    async request(pathOrUrl, options = {}) {
        const url = pathOrUrl.startsWith('http') ? pathOrUrl : `${API_BASE_URL}${pathOrUrl}`;
        const response = await fetch(url, {
            ...options,
            headers: {
                'Authorization': `Bearer ${this.apiToken}`,
                'Wanikani-Revision': WANIKANI_REVISION,
                ...(options.headers || {})
            }
        });

        if (!response.ok) {
            const errorText = await response.text().catch(() => '');
            throw new Error(`WaniKani API request failed: ${response.status} ${errorText}`);
        }

        return response;
    }

    async getJson(pathOrUrl) {
        const response = await this.request(pathOrUrl);
        return response.json();
    }

    async postJson(path, body) {
        const response = await this.request(path, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(body)
        });

        return response.json().catch(() => null);
    }

    async getPaginated(path, { limit = Infinity } = {}) {
        const items = [];
        let nextUrl = path;

        while (nextUrl && items.length < limit) {
            const data = await this.getJson(nextUrl);
            const pageItems = data.data || [];
            const remaining = limit - items.length;
            items.push(...pageItems.slice(0, remaining));
            nextUrl = data.pages?.next_url || null;
        }

        return items;
    }

    async getAssignments(query, options = {}) {
        return this.getPaginated(`/assignments?${query}`, options);
    }

    async getSubject(subjectId) {
        const data = await this.getJson(`/subjects/${subjectId}`);
        return { ...data.data, object: data.object };
    }

    async getSubjectsByIds(subjectIds) {
        const uniqueIds = [...new Set(subjectIds)].filter(Boolean);
        const subjects = [];
        const chunkSize = 100;

        for (let index = 0; index < uniqueIds.length; index += chunkSize) {
            const chunk = uniqueIds.slice(index, index + chunkSize);
            const data = await this.getPaginated(`/subjects?ids=${chunk.join(',')}`);
            subjects.push(...data.map((subject) => ({
                id: subject.id,
                ...subject.data,
                object: subject.object
            })));
        }

        return subjects;
    }

    async submitReview(assignmentId, incorrectMeaningCount, incorrectReadingCount) {
        return this.postJson('/reviews', {
            review: {
                assignment_id: assignmentId,
                incorrect_meaning_answers: incorrectMeaningCount,
                incorrect_reading_answers: incorrectReadingCount
            }
        });
    }
}
