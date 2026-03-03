import Kuroshiro from 'kuroshiro';
import KuromojiAnalyzer from 'kuroshiro-analyzer-kuromoji';

class WanikaniAuralReviews {
    constructor() {
        this.apiToken = localStorage.getItem('wanikani_api_token');
        this.currentReviews = [];
        this.currentReviewIndex = 0;
        this.recognition = null;
        this.synthesis = window.speechSynthesis;
        this.isListening = false;
        this.isPaused = false;
        this.continuousMode = false;
        this.continuousTimeout = null;
        this.autoAdvanceTimeout = null;

        // Track current review state (both meaning and reading must be answered)
        this.currentReviewState = null; // { assignmentId, subjectType, meaningAnswered, readingAnswered, incorrectMeaningCount, incorrectReadingCount }

        // Prevent re-evaluation of already answered questions
        this.answerLocked = false;
        
        // Local data cache
        this.kanjiData = new Map(); // character -> { readings: [], meanings: [] }
        this.vocabularyData = new Map(); // character -> { readings: [], meanings: [] }
        this.dataLoaded = false;
        
        // Kuroshiro for Japanese text conversion (lazy loaded)
        this.kuroshiro = null;
        this.kuroshiroInitialized = false;
        this.kuroshiroInitializing = false;

        this.initializeElements();
        this.initializeSpeechRecognition();
        this.initializeEventListeners();

        // Kuroshiro is now lazy-loaded when needed to avoid blocking page load

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
            startListening: document.getElementById('startListening'),
            continuousMode: document.getElementById('continuousMode'),
            listeningIndicator: document.getElementById('listeningIndicator'),
            userAnswer: document.getElementById('userAnswer'),
            resultSection: document.getElementById('resultSection'),
            resultMessage: document.getElementById('resultMessage'),
            correctAnswer: document.getElementById('correctAnswer'),
            nextQuestion: document.getElementById('nextQuestion'),
            pauseReviews: document.getElementById('pauseReviews'),
            changeApiToken: document.getElementById('changeApiToken'),
            endSession: document.getElementById('endSession'),
            retryButton: document.getElementById('retryButton'),
            errorMessage: document.getElementById('errorMessage')
        };
    }

    initializeSpeechRecognition() {
        if ('webkitSpeechRecognition' in window || 'SpeechRecognition' in window) {
            const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
            this.recognition = new SpeechRecognition();
            this.recognition.continuous = true; // Enable continuous mode
            this.recognition.interimResults = false;
            // Language will be set dynamically based on question type
            
            this.recognition.onstart = () => {
                this.isListening = true;
                this.elements.listeningIndicator.style.display = 'flex';
                this.elements.startListening.textContent = '🛑 Stop Listening';
            };
            
            this.recognition.onresult = async (event) => {
                console.log('Speech recognition result:', event.results);
                const result = event.results[event.results.length - 1][0];
                const transcript = result.transcript.toLowerCase().trim();
                const confidence = result.confidence;

                console.log('Transcript:', transcript, 'Confidence:', confidence);
                console.log('Recognition language:', this.recognition.lang);

                // Filter out low-confidence results (likely noise)
                if (confidence < 0.5) {
                    console.log('Ignoring low-confidence result:', confidence);
                    return;
                }

                // Filter out very short utterances (likely noise)
                if (transcript.length < 2) {
                    console.log('Ignoring short utterance:', transcript);
                    return;
                }
                
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
                
                // In continuous mode, restart listening after processing
                if (this.continuousMode && this.isListening) {
                    this.restartContinuousListening();
                }
            };
            
            this.recognition.onerror = (event) => {
                console.error('Speech recognition error:', event.error);
                // Don't show error for no-speech, just silently handle it
                if (event.error === 'no-speech') {
                    // In continuous mode, we'll restart via onend with a delay
                    // Don't spam the user with error messages
                    console.log('No speech detected, will retry...');
                } else {
                    this.elements.userAnswer.textContent = `Error: ${event.error}`;
                }
                this.stopListening();
            };
            
            this.recognition.onend = () => {
                console.log('Speech recognition ended');
                // In continuous mode, restart listening instead of stopping
                // But respect paused state and answer lock
                if (this.continuousMode && !this.isPaused && !this.answerLocked) {
                    this.isListening = false;
                    this.elements.listeningIndicator.style.display = 'none';
                    // Restart listening after a delay (longer to avoid rapid retries)
                    setTimeout(() => {
                        if (this.continuousMode && !this.isListening && !this.isPaused && !this.answerLocked) {
                            this.startListening();
                        }
                    }, 1000);
                } else {
                    this.stopListening();
                }
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

        this.elements.startListening.addEventListener('click', () => this.toggleListening());
        this.elements.nextQuestion.addEventListener('click', () => this.nextQuestion());
        this.elements.pauseReviews.addEventListener('click', () => this.togglePause());
        this.elements.endSession.addEventListener('click', () => this.endSession());
        this.elements.retryButton.addEventListener('click', () => this.retry());
        
        // Add event listeners for new elements if they exist
        if (this.elements.continuousMode) {
            this.elements.continuousMode.addEventListener('click', () => this.toggleContinuousMode());
        }
        if (this.elements.changeApiToken) {
            this.elements.changeApiToken.addEventListener('click', () => this.changeApiToken());
        }
        if (this.elements.clearApiToken) {
            this.elements.clearApiToken.addEventListener('click', () => this.clearApiToken());
        }
    }

    async initializeKuroshiro() {
        if (this.kuroshiroInitialized || this.kuroshiroInitializing) {
            return;
        }

        try {
            this.kuroshiroInitializing = true;
            console.log('Initializing Kuroshiro...');

            this.kuroshiro = new Kuroshiro();

            await this.kuroshiro.init(new KuromojiAnalyzer({
                dictPath: 'https://unpkg.com/kuromoji@0.1.2/dict/'
            }));

            this.kuroshiroInitialized = true;
            this.kuroshiroInitializing = false;
            console.log('Kuroshiro initialized successfully');
        } catch (error) {
            console.error('Failed to initialize Kuroshiro:', error);
            this.kuroshiroInitializing = false;
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

    changeApiToken() {
        if (confirm('Are you sure you want to change your API token? This will clear your current session.')) {
            localStorage.removeItem('wanikani_api_token');
            this.apiToken = null;
            this.showApiSetup();
        }
    }

    clearApiToken() {
        if (confirm('Are you sure you want to clear your API token? This will end your current session.')) {
            localStorage.removeItem('wanikani_api_token');
            this.apiToken = null;
            this.showApiSetup();
        }
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

        // Initialize review state for this assignment if not already set
        if (!this.currentReviewState || this.currentReviewState.assignmentId !== review.id) {
            this.currentReviewState = {
                assignmentId: review.id,
                subjectType: null, // Will be set when subject loads
                meaningAnswered: false,
                readingAnswered: false,
                incorrectMeaningCount: 0,
                incorrectReadingCount: 0
            };
        }

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

            // Update review state with subject type
            if (this.currentReviewState) {
                this.currentReviewState.subjectType = subject.object; // 'radical', 'kanji', or 'vocabulary'
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
            const questionType = this.determineQuestionType();

            this.elements.questionText.textContent = this.getQuestionText(questionType);
            this.currentQuestionType = questionType;

            // Automatically speak the question type
            this.speakQuestionType(questionType);

        } catch (error) {
            console.error('Error loading subject:', error);
            this.showError('Failed to load review item');
        }
    }

    speakQuestionType(questionType) {
        // Speak just "meaning" or "reading"
        const text = questionType === 'meaning' ? 'meaning' : 'reading';

        // After speech completes, wait a buffer then start listening (if in continuous mode)
        const onSpeechComplete = () => {
            if (this.continuousMode && !this.isPaused && !this.isListening) {
                // Add buffer after speech before listening starts
                setTimeout(() => {
                    if (this.continuousMode && !this.isPaused && !this.isListening && !this.answerLocked) {
                        this.startListening();
                    }
                }, 800);
            }
        };

        this.speak(text, onSpeechComplete);
    }

    determineQuestionType() {
        const state = this.currentReviewState;

        if (!state) {
            return 'meaning'; // Default fallback
        }

        // Radicals only have meanings, no readings
        const isRadical = state.subjectType === 'radical';

        // If meaning not yet answered, ask meaning first
        if (!state.meaningAnswered) {
            return 'meaning';
        }

        // If reading not yet answered and this subject has readings (not a radical)
        if (!state.readingAnswered && !isRadical) {
            return 'reading';
        }

        // Both answered (or radical with only meaning) - this shouldn't happen
        // as we should have moved to next question, but return meaning as fallback
        return 'meaning';
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

    speak(text, onComplete, lang = 'en-US') {
        if (this.synthesis.speaking) {
            this.synthesis.cancel();
        }

        const utterance = new SpeechSynthesisUtterance(text);
        utterance.lang = lang;
        utterance.rate = 0.8;
        utterance.pitch = 1;
        utterance.volume = 1;

        if (onComplete) {
            utterance.onend = onComplete;
        }

        this.synthesis.speak(utterance);
    }

    toggleListening() {
        if (this.isListening) {
            this.stopListening();
        } else {
            this.startListening();
        }
    }

    toggleContinuousMode() {
        this.continuousMode = !this.continuousMode;
        const button = this.elements.continuousMode;

        if (this.continuousMode) {
            button.textContent = '🔄 Continuous Mode: ON';
            button.className = 'btn btn-secondary active';
            // Start continuous listening if not already listening
            if (!this.isListening) {
                this.startListening();
            }
        } else {
            button.textContent = '🔄 Continuous Mode: OFF';
            button.className = 'btn btn-secondary';
            // Clear auto-advance timeout when turning off continuous mode
            if (this.autoAdvanceTimeout) {
                clearTimeout(this.autoAdvanceTimeout);
                this.autoAdvanceTimeout = null;
            }
            // Stop listening when turning off continuous mode
            if (this.isListening) {
                this.stopListening();
            }
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
            if (this.continuousMode && !this.isPaused) {
                // In continuous mode, just restart silently (onend will handle restart)
                this.recognition.stop();
            } else {
                this.elements.userAnswer.textContent = 'No speech detected. Please try again.';
                this.stopListening();
            }
        }, 10000);
        
        this.recognition.start();
    }

    stopListening() {
        console.log('Stopping speech recognition...');
        this.isListening = false;
        // Don't reset continuousMode here - it should only be toggled by the user
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
        
        if (this.continuousTimeout) {
            clearTimeout(this.continuousTimeout);
            this.continuousTimeout = null;
        }
        
        if (this.recognition) {
            this.recognition.stop();
        }
    }

    restartContinuousListening() {
        // Small delay before restarting to avoid immediate re-triggering
        this.continuousTimeout = setTimeout(() => {
            if (this.continuousMode && !this.isListening) {
                this.startListening();
            }
        }, 1000);
    }

    async processAnswer(userAnswer) {
        if (!this.currentSubject) return;

        // Prevent re-evaluation of already answered questions
        if (this.answerLocked) {
            console.log('Answer already evaluated, ignoring input');
            return;
        }

        // Check if we have a valid answer
        if (!userAnswer || userAnswer.trim() === '' || userAnswer === 'Listening...') {
            console.log('No valid answer received');
            this.elements.userAnswer.textContent = 'No answer detected. Please try again.';
            return;
        }

        // Lock answer evaluation and stop listening during feedback
        this.answerLocked = true;
        this.stopListening();

        const correctAnswers = this.getCorrectAnswers();
        console.log('User answer:', userAnswer);
        console.log('Correct answers:', correctAnswers);
        console.log('Question type:', this.currentQuestionType);

        const isCorrect = await this.checkAnswer(userAnswer, correctAnswers);
        console.log('Answer correct:', isCorrect);

        // Update review state with this answer
        this.recordAnswer(isCorrect);

        this.showResult(isCorrect, userAnswer, correctAnswers);

        // Check if this assignment's review is complete and submit if so
        await this.checkAndSubmitReview();
    }

    recordAnswer(isCorrect) {
        if (!this.currentReviewState) return;

        if (this.currentQuestionType === 'meaning') {
            this.currentReviewState.meaningAnswered = true;
            if (!isCorrect) {
                this.currentReviewState.incorrectMeaningCount++;
            }
        } else if (this.currentQuestionType === 'reading') {
            this.currentReviewState.readingAnswered = true;
            if (!isCorrect) {
                this.currentReviewState.incorrectReadingCount++;
            }
        }

        console.log('Review state updated:', this.currentReviewState);
    }

    isReviewComplete() {
        if (!this.currentReviewState) return false;

        const state = this.currentReviewState;
        const isRadical = state.subjectType === 'radical';

        // Radicals only need meaning answered
        if (isRadical) {
            return state.meaningAnswered;
        }

        // Kanji and vocabulary need both meaning and reading
        return state.meaningAnswered && state.readingAnswered;
    }

    async checkAndSubmitReview() {
        if (this.isReviewComplete()) {
            console.log('Review complete, submitting to WaniKani...');
            await this.submitReview();
        }
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
                    .map(r => r.reading)); // Don't convert to lowercase for Japanese
            }
        }
        
        return answers;
    }

    katakanaToHiragana(text) {
        // Katakana to Hiragana: subtract 0x60 from character code
        // Katakana range: U+30A1 to U+30F6
        // Hiragana range: U+3041 to U+3096
        return text.replace(/[\u30A1-\u30F6]/g, (char) => {
            return String.fromCharCode(char.charCodeAt(0) - 0x60);
        });
    }

    romajiToHiragana(text) {
        const romaji = text.toLowerCase();

        // Mapping from romaji to hiragana (ordered by length, longest first)
        const mappings = [
            // Four-character combinations
            ['xtsu', 'っ'],

            // Three-character combinations (combo syllables)
            ['kya', 'きゃ'], ['kyu', 'きゅ'], ['kyo', 'きょ'],
            ['sha', 'しゃ'], ['shu', 'しゅ'], ['sho', 'しょ'],
            ['cha', 'ちゃ'], ['chu', 'ちゅ'], ['cho', 'ちょ'],
            ['nya', 'にゃ'], ['nyu', 'にゅ'], ['nyo', 'にょ'],
            ['hya', 'ひゃ'], ['hyu', 'ひゅ'], ['hyo', 'ひょ'],
            ['mya', 'みゃ'], ['myu', 'みゅ'], ['myo', 'みょ'],
            ['rya', 'りゃ'], ['ryu', 'りゅ'], ['ryo', 'りょ'],
            ['gya', 'ぎゃ'], ['gyu', 'ぎゅ'], ['gyo', 'ぎょ'],
            ['jya', 'じゃ'], ['jyu', 'じゅ'], ['jyo', 'じょ'],
            ['bya', 'びゃ'], ['byu', 'びゅ'], ['byo', 'びょ'],
            ['pya', 'ぴゃ'], ['pyu', 'ぴゅ'], ['pyo', 'ぴょ'],
            ['shi', 'し'], ['chi', 'ち'], ['tsu', 'つ'], ['fou', 'ふぉ'],

            // Two-character combinations
            ['ka', 'か'], ['ki', 'き'], ['ku', 'く'], ['ke', 'け'], ['ko', 'こ'],
            ['sa', 'さ'], ['si', 'し'], ['su', 'す'], ['se', 'せ'], ['so', 'そ'],
            ['ta', 'た'], ['ti', 'ち'], ['tu', 'つ'], ['te', 'て'], ['to', 'と'],
            ['na', 'な'], ['ni', 'に'], ['nu', 'ぬ'], ['ne', 'ね'], ['no', 'の'],
            ['ha', 'は'], ['hi', 'ひ'], ['fu', 'ふ'], ['hu', 'ふ'], ['he', 'へ'], ['ho', 'ほ'],
            ['ma', 'ま'], ['mi', 'み'], ['mu', 'む'], ['me', 'め'], ['mo', 'も'],
            ['ya', 'や'], ['yu', 'ゆ'], ['yo', 'よ'],
            ['ra', 'ら'], ['ri', 'り'], ['ru', 'る'], ['re', 'れ'], ['ro', 'ろ'],
            ['wa', 'わ'], ['wi', 'ゐ'], ['we', 'ゑ'], ['wo', 'を'],
            ['ga', 'が'], ['gi', 'ぎ'], ['gu', 'ぐ'], ['ge', 'げ'], ['go', 'ご'],
            ['za', 'ざ'], ['ji', 'じ'], ['zi', 'じ'], ['zu', 'ず'], ['ze', 'ぜ'], ['zo', 'ぞ'],
            ['da', 'だ'], ['di', 'ぢ'], ['du', 'づ'], ['de', 'で'], ['do', 'ど'],
            ['ba', 'ば'], ['bi', 'び'], ['bu', 'ぶ'], ['be', 'べ'], ['bo', 'ぼ'],
            ['pa', 'ぱ'], ['pi', 'ぴ'], ['pu', 'ぷ'], ['pe', 'ぺ'], ['po', 'ぽ'],
            ['ja', 'じゃ'], ['ju', 'じゅ'], ['jo', 'じょ'],
            ['fa', 'ふぁ'], ['fi', 'ふぃ'], ['fe', 'ふぇ'], ['fo', 'ふぉ'],
            ['nn', 'ん'],

            // Single vowels
            ['a', 'あ'], ['i', 'い'], ['u', 'う'], ['e', 'え'], ['o', 'お'],

            // Standalone n (handled specially below)
        ];

        let result = romaji;

        // Handle double consonants (small tsu) - kk, tt, pp, ss, etc.
        // Replace the first consonant of a double with っ
        result = result.replace(/([kstpgzdbcfhjmrw])\1/g, 'っ$1');

        // Apply mappings from longest to shortest
        for (const [rom, hira] of mappings) {
            result = result.split(rom).join(hira);
        }

        // Handle standalone 'n' at end of word or before non-vowel
        // n followed by a vowel or y would have been converted already
        result = result.replace(/n(?![aiueoy]|$)/g, 'ん');
        result = result.replace(/n$/g, 'ん');

        console.log(`Romaji to hiragana: "${text}" -> "${result}"`);
        return result;
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

            // For Japanese readings, handle katakana and kanji to hiragana conversion
            if (this.currentQuestionType === 'reading') {
                // Check direct match (preserve hiragana/katakana)
                if (userAnswer === correctAnswer) {
                    return true;
                }

                // Convert katakana to hiragana
                const userAsHiragana = this.katakanaToHiragana(userAnswer);
                if (userAsHiragana === correctAnswer) {
                    return true;
                }

                // Convert user's kanji answer to hiragana for comparison
                const userHiragana = await this.convertToHiragana(userAnswer);
                if (userHiragana === correctAnswer) {
                    return true;
                }

                // Also try converting the kanji result through katakana to hiragana
                const userHiraganaFromKatakana = this.katakanaToHiragana(userHiragana);
                if (userHiraganaFromKatakana === correctAnswer) {
                    return true;
                }

                // Try converting romaji to hiragana
                const userFromRomaji = this.romajiToHiragana(userAnswer);
                if (userFromRomaji === correctAnswer) {
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

        // Lazy-initialize Kuroshiro on first use (non-blocking)
        if (!this.kuroshiroInitialized && !this.kuroshiroInitializing) {
            // Start initialization in background, don't wait for it
            this.initializeKuroshiro();
        }

        // Try Kuroshiro if already initialized
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

        const correctAnswerText = correctAnswers.join(', ');
        console.log('Correct answers for display:', correctAnswers);
        console.log('Question type:', this.currentQuestionType);

        // Callback to advance after speech completes (for continuous mode)
        const onSpeechComplete = () => {
            if (this.continuousMode) {
                // Small buffer before advancing to next question
                setTimeout(() => {
                    if (this.continuousMode) {
                        this.nextQuestion();
                    }
                }, 500);
            }
        };

        if (isCorrect) {
            this.elements.resultMessage.textContent = '✅ Correct!';
            this.elements.resultMessage.className = 'result-message correct';

            // Speak "Correct" followed by the answer
            if (this.currentQuestionType === 'reading') {
                this.speak(`正解。${correctAnswerText}`, onSpeechComplete, 'ja-JP');
            } else {
                this.speak(`Correct. ${correctAnswerText}`, onSpeechComplete);
            }
        } else {
            this.elements.resultMessage.textContent = `❌ Incorrect: the answer is ${correctAnswerText}`;
            this.elements.resultMessage.className = 'result-message incorrect';
            this.elements.correctAnswer.textContent = '';

            // Speak the feedback with the correct answer
            if (this.currentQuestionType === 'reading') {
                this.speak(`ちがいます。正解は${correctAnswerText}です。`, onSpeechComplete, 'ja-JP');
            } else {
                this.speak(`Incorrect. The correct answer is ${correctAnswers.join(' or ')}`, onSpeechComplete);
            }
        }
    }

    async submitReview() {
        if (!this.currentReviewState) {
            console.error('No review state to submit');
            return;
        }

        try {
            const state = this.currentReviewState;
            const endpoint = `https://api.wanikani.com/v2/reviews`;

            const payload = {
                review: {
                    assignment_id: state.assignmentId,
                    incorrect_meaning_answers: state.incorrectMeaningCount,
                    incorrect_reading_answers: state.incorrectReadingCount
                }
            };

            console.log('Submitting review:', payload);

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
                const errorText = await response.text();
                console.error('Failed to submit review:', response.status, errorText);
            } else {
                console.log('Review submitted successfully');
            }

        } catch (error) {
            console.error('Error submitting review:', error);
        }
    }

    nextQuestion() {
        // Check if current assignment still needs more questions
        if (!this.isReviewComplete()) {
            // Same assignment, just show the next question type (reading after meaning)
            this.resetAnswerSection();
            const questionType = this.determineQuestionType();
            this.elements.questionText.textContent = this.getQuestionText(questionType);
            this.currentQuestionType = questionType;
            this.updateProgress(); // Update to show (reading) indicator
            this.speakQuestionType(questionType); // Speak the question type
        } else {
            // Move to next assignment
            this.currentReviewIndex++;
            this.currentReviewState = null; // Clear state for next assignment
            this.displayCurrentReview();
        }
    }

    togglePause() {
        this.isPaused = !this.isPaused;
        this.elements.pauseReviews.textContent = this.isPaused ? 'Resume Reviews' : 'Pause Reviews';

        if (this.isPaused) {
            // Stop listening when paused
            this.stopListening();
            this.speak('Reviews paused');
        } else {
            this.speak('Reviews resumed');
            // Restart listening if in continuous mode
            if (this.continuousMode && !this.isListening) {
                setTimeout(() => {
                    if (this.continuousMode && !this.isPaused && !this.isListening) {
                        this.startListening();
                    }
                }, 1000);
            }
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

        // Show which part of the review we're on
        let questionPart = '';
        if (this.currentReviewState) {
            const isRadical = this.currentReviewState.subjectType === 'radical';
            if (!this.currentReviewState.meaningAnswered) {
                questionPart = isRadical ? '' : ' (meaning)';
            } else if (!this.currentReviewState.readingAnswered && !isRadical) {
                questionPart = ' (reading)';
            }
        }

        this.elements.progressText.textContent = `${this.currentReviewIndex + 1} / ${this.currentReviews.length}${questionPart}`;
    }

    resetAnswerSection() {
        this.elements.resultSection.style.display = 'none';
        this.elements.userAnswer.textContent = '';
        this.elements.correctAnswer.textContent = '';

        // Unlock answer evaluation for new question
        this.answerLocked = false;

        // Clear any pending auto-advance
        if (this.autoAdvanceTimeout) {
            clearTimeout(this.autoAdvanceTimeout);
            this.autoAdvanceTimeout = null;
        }

        this.stopListening();

        // Listening will be started by speakQuestionType after speech completes
    }
}

// Initialize the app when the page loads
document.addEventListener('DOMContentLoaded', () => {
    new WanikaniAuralReviews();
});