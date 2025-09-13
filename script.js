class WanikaniAuralReviews {
    constructor() {
        this.apiToken = localStorage.getItem('wanikani_api_token');
        this.currentReviews = [];
        this.currentReviewIndex = 0;
        this.recognition = null;
        this.synthesis = window.speechSynthesis;
        this.isListening = false;
        this.isPaused = false;
        
        // Local data cache
        this.kanjiData = new Map(); // character -> { readings: [], meanings: [] }
        this.vocabularyData = new Map(); // character -> { readings: [], meanings: [] }
        this.dataLoaded = false;
        
        // Kuroshiro for Japanese text conversion
        this.kuroshiro = null;
        this.kuroshiroInitialized = false;
        
        this.initializeElements();
        this.initializeSpeechRecognition();
        this.initializeEventListeners();
        
        // Wait a bit for scripts to load, then initialize kuroshiro
        setTimeout(() => {
            this.initializeKuroshiro().then(() => {
                // Test kuroshiro after initialization
                this.testKuroshiro();
            });
        }, 1000);
        
        if (this.apiToken) {
            this.loadWanikaniData().then(() => {
                this.startReviews();
            });
        } else {
            this.showApiSetup();
        }
    }

    initializeElements() {
        this.elements = {
            apiSetup: document.getElementById('apiSetup'),
            reviewInterface: document.getElementById('reviewInterface'),
            loading: document.getElementById('loading'),
            error: document.getElementById('error'),
            apiToken: document.getElementById('apiToken'),
            saveToken: document.getElementById('saveToken'),
            progressFill: document.getElementById('progressFill'),
            progressText: document.getElementById('progressText'),
            itemType: document.getElementById('itemType'),
            itemCharacter: document.getElementById('itemCharacter'),
            questionText: document.getElementById('questionText'),
            playQuestion: document.getElementById('playQuestion'),
            startListening: document.getElementById('startListening'),
            listeningIndicator: document.getElementById('listeningIndicator'),
            userAnswer: document.getElementById('userAnswer'),
            resultSection: document.getElementById('resultSection'),
            resultMessage: document.getElementById('resultMessage'),
            correctAnswer: document.getElementById('correctAnswer'),
            nextQuestion: document.getElementById('nextQuestion'),
            pauseReviews: document.getElementById('pauseReviews'),
            endSession: document.getElementById('endSession'),
            retryButton: document.getElementById('retryButton'),
            errorMessage: document.getElementById('errorMessage')
        };
    }

    initializeSpeechRecognition() {
        if ('webkitSpeechRecognition' in window || 'SpeechRecognition' in window) {
            const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
            this.recognition = new SpeechRecognition();
            this.recognition.continuous = false;
            this.recognition.interimResults = false;
            // Language will be set dynamically based on question type
            
            this.recognition.onstart = () => {
                this.isListening = true;
                this.elements.listeningIndicator.style.display = 'flex';
                this.elements.startListening.textContent = '🛑 Stop Listening';
            };
            
            this.recognition.onresult = async (event) => {
                console.log('Speech recognition result:', event.results);
                const transcript = event.results[0][0].transcript.toLowerCase().trim();
                console.log('Transcript:', transcript);
                console.log('Recognition language:', this.recognition.lang);
                
                // For Japanese reading questions, convert kanji to hiragana for display
                if (this.currentQuestionType === 'reading') {
                    try {
                        const convertedTranscript = await this.convertToHiragana(transcript);
                        console.log('Converted transcript:', convertedTranscript);
                        this.elements.userAnswer.textContent = `${transcript} → ${convertedTranscript}`;
                    } catch (error) {
                        console.warn('Failed to convert transcript:', error);
                        this.elements.userAnswer.textContent = transcript;
                    }
                } else {
                    this.elements.userAnswer.textContent = transcript;
                }
                
                this.processAnswer(transcript);
            };
            
            this.recognition.onerror = (event) => {
                console.error('Speech recognition error:', event.error);
                this.elements.userAnswer.textContent = `Error: ${event.error}`;
                this.stopListening();
            };
            
            this.recognition.onend = () => {
                console.log('Speech recognition ended');
                this.stopListening();
            };
        } else {
            console.warn('Speech recognition not supported');
        }
    }

    initializeEventListeners() {
        this.elements.saveToken.addEventListener('click', () => this.saveApiToken());
        this.elements.apiToken.addEventListener('keypress', (e) => {
            if (e.key === 'Enter') this.saveApiToken();
        });
        
        this.elements.playQuestion.addEventListener('click', () => this.playQuestion());
        this.elements.startListening.addEventListener('click', () => this.toggleListening());
        this.elements.nextQuestion.addEventListener('click', () => this.nextQuestion());
        this.elements.pauseReviews.addEventListener('click', () => this.togglePause());
        this.elements.endSession.addEventListener('click', () => this.endSession());
        this.elements.retryButton.addEventListener('click', () => this.retry());
    }

    async initializeKuroshiro() {
        try {
            if (typeof Kuroshiro === 'undefined' || typeof KuromojiAnalyzer === 'undefined') {
                console.warn('Kuroshiro libraries not loaded, falling back to local conversion');
                return;
            }

            // Kuroshiro is an ES module, so we need to use .default
            this.kuroshiro = new Kuroshiro.default();
            
            // Initialize with kuromoji analyzer using CDN dictionary path
            await this.kuroshiro.init(new KuromojiAnalyzer({ 
                dictPath: "https://unpkg.com/kuromoji@0.1.2/dict/" 
            }));
            this.kuroshiroInitialized = true;
            console.log('Kuroshiro initialized successfully');
        } catch (error) {
            console.error('Failed to initialize Kuroshiro:', error);
            this.kuroshiroInitialized = false;
        }
    }

    async testKuroshiro() {
        if (this.kuroshiroInitialized && this.kuroshiro) {
            try {
                const testResult = await this.kuroshiro.convert('学校', { to: 'hiragana' });
                console.log('Kuroshiro test successful:', testResult);
            } catch (error) {
                console.error('Kuroshiro test failed:', error);
            }
        } else {
            console.log('Kuroshiro not initialized, skipping test');
        }
    }

    async saveApiToken() {
        const token = this.elements.apiToken.value.trim();
        if (!token) {
            this.showError('Please enter your API token');
            return;
        }
        
        this.apiToken = token;
        localStorage.setItem('wanikani_api_token', token);
        
        await this.loadWanikaniData();
        await this.startReviews();
    }

    async loadWanikaniData() {
        console.log('Loading Wanikani data...');
        this.showLoading();
        
        try {
            // Check if we have cached data
            const cachedData = localStorage.getItem('wanikani_data_cache');
            const cacheTimestamp = localStorage.getItem('wanikani_data_timestamp');
            const oneDay = 24 * 60 * 60 * 1000; // 24 hours in milliseconds
            
            if (cachedData && cacheTimestamp && (Date.now() - parseInt(cacheTimestamp)) < oneDay) {
                console.log('Using cached Wanikani data');
                this.parseCachedData(JSON.parse(cachedData));
                this.dataLoaded = true;
                return;
            }
            
            console.log('Downloading fresh Wanikani data...');
            
            // Download all kanji data
            await this.downloadAllSubjects('kanji');
            
            // Download all vocabulary data
            await this.downloadAllSubjects('vocabulary');
            
            // Cache the data
            const dataToCache = {
                kanji: Array.from(this.kanjiData.entries()),
                vocabulary: Array.from(this.vocabularyData.entries())
            };
            
            localStorage.setItem('wanikani_data_cache', JSON.stringify(dataToCache));
            localStorage.setItem('wanikani_data_timestamp', Date.now().toString());
            
            this.dataLoaded = true;
            console.log('Wanikani data loaded successfully');
            
        } catch (error) {
            console.error('Error loading Wanikani data:', error);
            this.showError('Failed to load Wanikani data. Please check your API token and try again.');
        }
    }

    parseCachedData(cachedData) {
        this.kanjiData = new Map(cachedData.kanji);
        this.vocabularyData = new Map(cachedData.vocabulary);
        console.log(`Loaded ${this.kanjiData.size} kanji and ${this.vocabularyData.size} vocabulary items from cache`);
    }

    async downloadAllSubjects(type) {
        let nextUrl = `https://api.wanikani.com/v2/subjects?types=${type}`;
        let totalDownloaded = 0;
        
        while (nextUrl) {
            console.log(`Downloading ${type} batch...`);
            
            const response = await fetch(nextUrl, {
                headers: {
                    'Authorization': `Bearer ${this.apiToken}`,
                    'Wanikani-Revision': '20170710'
                }
            });
            
            if (!response.ok) {
                throw new Error(`API request failed: ${response.status}`);
            }
            
            const data = await response.json();
            
            // Process the subjects
            for (const subject of data.data) {
                const characters = subject.characters || subject.slug;
                const readings = subject.readings ? subject.readings.filter(r => r.accepted_answer).map(r => r.reading) : [];
                const meanings = subject.meanings ? subject.meanings.filter(m => m.accepted_answer).map(m => m.meaning) : [];
                
                if (type === 'kanji') {
                    this.kanjiData.set(characters, { readings, meanings });
                } else {
                    this.vocabularyData.set(characters, { readings, meanings });
                }
            }
            
            totalDownloaded += data.data.length;
            console.log(`Downloaded ${totalDownloaded} ${type} subjects so far...`);
            
            // Check for next page
            nextUrl = data.pages ? data.pages.next_url : null;
            
            // Add a small delay to be respectful to the API
            if (nextUrl) {
                await new Promise(resolve => setTimeout(resolve, 100));
            }
        }
        
        console.log(`Finished downloading ${totalDownloaded} ${type} subjects`);
    }

    showApiSetup() {
        this.elements.apiSetup.style.display = 'flex';
        this.elements.reviewInterface.style.display = 'none';
        this.elements.loading.style.display = 'none';
        this.elements.error.style.display = 'none';
    }

    showLoading() {
        this.elements.apiSetup.style.display = 'none';
        this.elements.reviewInterface.style.display = 'none';
        this.elements.loading.style.display = 'flex';
        this.elements.error.style.display = 'none';
    }

    showReviews() {
        this.elements.apiSetup.style.display = 'none';
        this.elements.reviewInterface.style.display = 'flex';
        this.elements.loading.style.display = 'none';
        this.elements.error.style.display = 'none';
    }

    showError(message) {
        this.elements.errorMessage.textContent = message;
        this.elements.apiSetup.style.display = 'none';
        this.elements.reviewInterface.style.display = 'none';
        this.elements.loading.style.display = 'none';
        this.elements.error.style.display = 'flex';
    }

    async startReviews() {
        this.showLoading();
        
        try {
            // Make sure data is loaded before starting reviews
            if (!this.dataLoaded) {
                console.log('Data not loaded yet, waiting...');
                await this.loadWanikaniData();
            }
            
            await this.fetchReviews();
            if (this.currentReviews.length === 0) {
                this.showError('No reviews available at this time. Check back later!');
                return;
            }
            this.showReviews();
            this.displayCurrentReview();
        } catch (error) {
            console.error('Error starting reviews:', error);
            this.showError('Failed to load reviews. Please check your API token and try again.');
        }
    }

    async fetchReviews() {
        const response = await fetch('https://api.wanikani.com/v2/assignments?immediately_available_for_review=true', {
            headers: {
                'Authorization': `Bearer ${this.apiToken}`,
                'Wanikani-Revision': '20170710'
            }
        });

        if (!response.ok) {
            throw new Error(`API request failed: ${response.status}`);
        }

        const data = await response.json();
        this.currentReviews = data.data || [];
        this.currentReviewIndex = 0;
    }

    async fetchSubject(subjectId) {
        const response = await fetch(`https://api.wanikani.com/v2/subjects/${subjectId}`, {
            headers: {
                'Authorization': `Bearer ${this.apiToken}`,
                'Wanikani-Revision': '20170710'
            }
        });

        if (!response.ok) {
            throw new Error(`Failed to fetch subject: ${response.status}`);
        }

        const data = await response.json();
        console.log('Fetched subject data:', data.data); // Debug log
        return data.data;
    }

    displayCurrentReview() {
        if (this.currentReviewIndex >= this.currentReviews.length) {
            this.showError('All reviews completed! Great job!');
            return;
        }

        const review = this.currentReviews[this.currentReviewIndex];
        this.loadSubjectData(review.data.subject_id);
        this.updateProgress();
        this.resetAnswerSection();
    }

    async loadSubjectData(subjectId) {
        try {
            const subject = await this.fetchSubject(subjectId);
            console.log('Subject received in loadSubjectData:', subject); // Debug log
            
            this.currentSubject = subject;
            
            // The subject IS the data object from the API response
            if (!subject) {
                throw new Error('No subject data received');
            }
            
            this.elements.itemType.textContent = subject.object || 'Unknown';
            
            // Handle different subject types (radicals, kanji, vocabulary)
            let characters = 'N/A';
            if (subject.characters) {
                characters = subject.characters;
            } else if (subject.slug) {
                // For radicals without characters, use the slug
                characters = subject.slug;
            }
            
            this.elements.itemCharacter.textContent = characters;
            
            // Determine question type and text
            const assignment = this.currentReviews[this.currentReviewIndex];
            const questionType = this.determineQuestionType(assignment);
            
            this.elements.questionText.textContent = this.getQuestionText(questionType);
            this.currentQuestionType = questionType;
            
        } catch (error) {
            console.error('Error loading subject:', error);
            this.showError('Failed to load review item');
        }
    }

    determineQuestionType(assignment) {
        // Simple logic to determine question type based on available reviews
        const availableReviews = assignment.data.available_at;
        const srsStage = assignment.data.srs_stage;
        
        // For now, alternate between meaning and reading
        // In a real implementation, you'd use Wanikani's review logic
        return this.currentReviewIndex % 2 === 0 ? 'meaning' : 'reading';
    }

    getQuestionText(questionType) {
        switch (questionType) {
            case 'meaning':
                return 'What is the meaning of this item?';
            case 'reading':
                return 'What is the reading of this item?';
            default:
                return 'What is the answer?';
        }
    }

    playQuestion() {
        if (!this.currentSubject) return;
        
        const questionText = this.elements.questionText.textContent;
        let itemText = 'this item';
        
        if (this.currentSubject.characters) {
            itemText = this.currentSubject.characters;
        } else if (this.currentSubject.slug) {
            itemText = this.currentSubject.slug;
        }
        
        const fullText = `${questionText} ${itemText}`;
        
        this.speak(fullText);
    }

    speak(text) {
        if (this.synthesis.speaking) {
            this.synthesis.cancel();
        }
        
        const utterance = new SpeechSynthesisUtterance(text);
        utterance.rate = 0.8;
        utterance.pitch = 1;
        utterance.volume = 1;
        
        this.synthesis.speak(utterance);
    }

    toggleListening() {
        if (this.isListening) {
            this.stopListening();
        } else {
            this.startListening();
        }
    }

    startListening() {
        if (!this.recognition) {
            this.showError('Speech recognition is not supported in your browser');
            return;
        }
        
        // Set language based on question type
        if (this.currentQuestionType === 'reading') {
            this.recognition.lang = 'ja-JP'; // Japanese for readings
            console.log('Set speech recognition to Japanese for reading question');
            this.elements.startListening.textContent = '🎤 Start Speaking (Japanese)';
        } else {
            this.recognition.lang = 'en-US'; // English for meanings
            console.log('Set speech recognition to English for meaning question');
            this.elements.startListening.textContent = '🎤 Start Speaking (English)';
        }
        
        console.log('Starting speech recognition...');
        this.elements.userAnswer.textContent = 'Listening...';
        
        // Set a timeout to stop listening after 10 seconds
        this.listeningTimeout = setTimeout(() => {
            console.log('Speech recognition timeout');
            this.elements.userAnswer.textContent = 'No speech detected. Please try again.';
            this.stopListening();
        }, 10000);
        
        this.recognition.start();
    }

    stopListening() {
        console.log('Stopping speech recognition...');
        this.isListening = false;
        this.elements.listeningIndicator.style.display = 'none';
        
        // Reset button text based on question type
        if (this.currentQuestionType === 'reading') {
            this.elements.startListening.textContent = '🎤 Start Speaking (Japanese)';
        } else {
            this.elements.startListening.textContent = '🎤 Start Speaking (English)';
        }
        
        // Clear the timeout
        if (this.listeningTimeout) {
            clearTimeout(this.listeningTimeout);
            this.listeningTimeout = null;
        }
        
        if (this.recognition) {
            this.recognition.stop();
        }
    }

    async processAnswer(userAnswer) {
        if (!this.currentSubject) return;
        
        // Check if we have a valid answer
        if (!userAnswer || userAnswer.trim() === '' || userAnswer === 'Listening...') {
            console.log('No valid answer received');
            this.elements.userAnswer.textContent = 'No answer detected. Please try again.';
            return;
        }
        
        const correctAnswers = this.getCorrectAnswers();
        console.log('User answer:', userAnswer);
        console.log('Correct answers:', correctAnswers);
        console.log('Question type:', this.currentQuestionType);
        
        const isCorrect = await this.checkAnswer(userAnswer, correctAnswers);
        console.log('Answer correct:', isCorrect);
        
        this.showResult(isCorrect, userAnswer, correctAnswers);
        this.submitAnswer(isCorrect);
    }

    getCorrectAnswers() {
        if (!this.currentSubject) return [];
        
        const answers = [];
        
        if (this.currentQuestionType === 'meaning') {
            // Get meanings
            if (this.currentSubject.meanings && Array.isArray(this.currentSubject.meanings)) {
                answers.push(...this.currentSubject.meanings
                    .filter(m => m && m.accepted_answer)
                    .map(m => m.meaning.toLowerCase()));
            }
        } else if (this.currentQuestionType === 'reading') {
            // Get readings
            if (this.currentSubject.readings && Array.isArray(this.currentSubject.readings)) {
                answers.push(...this.currentSubject.readings
                    .filter(r => r && r.accepted_answer)
                    .map(r => r.reading.toLowerCase()));
            }
        }
        
        return answers;
    }

    async checkAnswer(userAnswer, correctAnswers) {
        const normalizedUserAnswer = userAnswer.toLowerCase().trim();
        
        // Check direct matches first
        for (const correctAnswer of correctAnswers) {
            const normalizedCorrect = correctAnswer.toLowerCase().trim();
            
            // Direct match
            if (normalizedUserAnswer === normalizedCorrect) {
                return true;
            }
            
            // For Japanese readings, handle kanji to hiragana conversion
            if (this.currentQuestionType === 'reading') {
                // Check direct match (preserve hiragana/katakana)
                if (userAnswer === correctAnswer) {
                    return true;
                }
                
                // Convert user's kanji answer to hiragana for comparison
                const userHiragana = await this.convertToHiragana(userAnswer);
                if (userHiragana === correctAnswer) {
                    return true;
                }
            }
            
            // Check for partial matches
            if (normalizedUserAnswer.includes(normalizedCorrect) ||
                normalizedCorrect.includes(normalizedUserAnswer)) {
                return true;
            }
        }
        
        return false;
    }

    async convertToHiragana(text) {
        console.log(`Converting "${text}" to hiragana...`);
        
        // First, try Kuroshiro if available
        if (this.kuroshiroInitialized && this.kuroshiro) {
            try {
                const hiragana = await this.kuroshiro.convert(text, { to: 'hiragana' });
                console.log(`Kuroshiro conversion: "${text}" to "${hiragana}"`);
                return hiragana;
            } catch (error) {
                console.warn('Kuroshiro conversion failed:', error);
            }
        }
        
        // Fallback to local Wanikani data
        console.log(`Using local data fallback for "${text}"`);
        console.log(`Data loaded: ${this.dataLoaded}`);
        console.log(`Kanji data size: ${this.kanjiData.size}`);
        console.log(`Vocabulary data size: ${this.vocabularyData.size}`);
        
        // First, check if this is the exact kanji from the current subject
        if (this.currentSubject && this.currentSubject.characters === text) {
            // This is the exact kanji we're reviewing, use its readings
            if (this.currentSubject.readings && this.currentSubject.readings.length > 0) {
                const acceptedReading = this.currentSubject.readings.find(r => r.accepted_answer);
                if (acceptedReading) {
                    console.log(`Found exact match reading "${acceptedReading.reading}" for current subject kanji "${text}"`);
                    return acceptedReading.reading;
                }
            }
        }
        
        // Try to look up the entire compound kanji as a vocabulary item
        const vocabularyData = this.vocabularyData.get(text);
        console.log(`Vocabulary lookup for "${text}":`, vocabularyData);
        if (vocabularyData && vocabularyData.readings.length > 0) {
            const reading = vocabularyData.readings[0]; // Use first accepted reading
            console.log(`Found vocabulary reading "${reading}" for "${text}"`);
            return reading;
        }
        
        // If not found as vocabulary, try to look up each individual character
        let result = text;
        const kanjiCharacters = this.extractKanji(text);
        console.log(`Extracted kanji characters:`, kanjiCharacters);
        
        for (const kanji of kanjiCharacters) {
            const kanjiData = this.kanjiData.get(kanji);
            console.log(`Kanji lookup for "${kanji}":`, kanjiData);
            if (kanjiData && kanjiData.readings.length > 0) {
                const reading = kanjiData.readings[0]; // Use first accepted reading
                result = result.replace(new RegExp(kanji, 'g'), reading);
                console.log(`Converted kanji "${kanji}" to "${reading}"`);
            } else {
                console.log(`No data found for kanji "${kanji}"`);
            }
        }
        
        // If no conversion happened and we have the same result, try fallback
        if (result === text && !this.dataLoaded) {
            console.log('Data not loaded yet, trying fallback dictionary...');
            const fallbackReading = this.getFallbackReading(text);
            if (fallbackReading) {
                console.log(`Using fallback reading "${fallbackReading}" for "${text}"`);
                return fallbackReading;
            }
        }
        
        console.log(`Final conversion: "${text}" to "${result}"`);
        return result;
    }

    extractKanji(text) {
        // Extract kanji characters from text
        const kanjiRegex = /[\u4e00-\u9faf]/g;
        const matches = text.match(kanjiRegex);
        return matches ? [...new Set(matches)] : []; // Remove duplicates
    }


    getFallbackReading(kanji) {
        // Minimal fallback dictionary for only the most basic cases
        // Kuroshiro should handle most conversions now
        const fallbackReadings = {
            // Only keep the most essential single kanji
            '一': 'いち',
            '二': 'に', 
            '三': 'さん',
            '四': 'よん',
            '五': 'ご',
            '六': 'ろく',
            '七': 'なな',
            '八': 'はち',
            '九': 'きゅう',
            '十': 'じゅう',
            '人': 'ひと',
            '水': 'みず',
            '火': 'ひ',
            '木': 'き',
            '金': 'きん',
            '土': 'つち',
            '日': 'ひ',
            '月': 'つき'
        };
        
        const reading = fallbackReadings[kanji];
        if (reading) {
            console.log(`Using minimal fallback reading "${reading}" for kanji "${kanji}"`);
        }
        return reading || null;
    }


    showResult(isCorrect, userAnswer, correctAnswers) {
        this.elements.resultSection.style.display = 'block';
        
        if (isCorrect) {
            this.elements.resultMessage.textContent = '✅ Correct!';
            this.elements.resultMessage.className = 'result-message correct';
            this.speak('Correct!');
        } else {
            this.elements.resultMessage.textContent = '❌ Incorrect';
            this.elements.resultMessage.className = 'result-message incorrect';
            this.elements.correctAnswer.textContent = `Correct answer: ${correctAnswers.join(', ')}`;
            this.speak(`Incorrect. The correct answer is ${correctAnswers.join(' or ')}`);
        }
    }

    async submitAnswer(isCorrect) {
        try {
            const assignment = this.currentReviews[this.currentReviewIndex];
            const endpoint = `https://api.wanikani.com/v2/reviews`;
            
            const payload = {
                review: {
                    assignment_id: assignment.id,
                    incorrect_meaning_answers: this.currentQuestionType === 'meaning' && !isCorrect ? 1 : 0,
                    incorrect_reading_answers: this.currentQuestionType === 'reading' && !isCorrect ? 1 : 0
                }
            };
            
            const response = await fetch(endpoint, {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${this.apiToken}`,
                    'Wanikani-Revision': '20170710',
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify(payload)
            });
            
            if (!response.ok) {
                console.error('Failed to submit answer:', response.status);
            }
            
        } catch (error) {
            console.error('Error submitting answer:', error);
        }
    }

    nextQuestion() {
        this.currentReviewIndex++;
        this.displayCurrentReview();
    }

    togglePause() {
        this.isPaused = !this.isPaused;
        this.elements.pauseReviews.textContent = this.isPaused ? 'Resume Reviews' : 'Pause Reviews';
        
        if (this.isPaused) {
            this.speak('Reviews paused');
        } else {
            this.speak('Reviews resumed');
        }
    }

    endSession() {
        if (confirm('Are you sure you want to end this review session?')) {
            localStorage.removeItem('wanikani_api_token');
            this.apiToken = null;
            this.showApiSetup();
            this.speak('Review session ended');
        }
    }

    clearCache() {
        localStorage.removeItem('wanikani_data_cache');
        localStorage.removeItem('wanikani_data_timestamp');
        this.kanjiData.clear();
        this.vocabularyData.clear();
        this.dataLoaded = false;
        console.log('Wanikani data cache cleared');
    }

    retry() {
        this.startReviews();
    }

    updateProgress() {
        const progress = ((this.currentReviewIndex + 1) / this.currentReviews.length) * 100;
        this.elements.progressFill.style.width = `${progress}%`;
        this.elements.progressText.textContent = `${this.currentReviewIndex + 1} / ${this.currentReviews.length}`;
    }

    resetAnswerSection() {
        this.elements.resultSection.style.display = 'none';
        this.elements.userAnswer.textContent = '';
        this.elements.correctAnswer.textContent = '';
        this.stopListening();
    }
}

// Initialize the app when the page loads
document.addEventListener('DOMContentLoaded', () => {
    new WanikaniAuralReviews();
});