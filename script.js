import Kuroshiro from 'kuroshiro';
import KuromojiAnalyzer from 'kuroshiro-analyzer-kuromoji';
import { WanikaniApiClient } from './wanikani-api.js';
import { SubjectStore } from './subject-store.js';
import { BurnedPracticeStore } from './burned-practice-store.js';
import { DEFAULT_PRACTICE_MODE_ID, PRACTICE_MODES, buildPracticeSession, getPracticeMode } from './practice-modes.js';

class WanikaniAuralReviews {
    constructor() {
        this.apiToken = localStorage.getItem('wanikani_api_token');
        this.apiClient = new WanikaniApiClient(this.apiToken);
        this.subjectStore = new SubjectStore(this.apiClient);
        this.burnedPracticeStore = new BurnedPracticeStore();
        this.currentReviews = [];
        this.currentReviewIndex = 0;
        this.currentSession = null;
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

        // Awaiting confirmation before submitting review with incorrect answers
        this.awaitingSubmitConfirmation = false;

        // Prevent rapid restart loops in speech recognition
        this.lastRecognitionStartTime = 0;
        this.consecutiveAborts = 0;

        // Local data cache
        this.kanjiData = new Map(); // character -> { readings: [], meanings: [] }
        this.vocabularyData = new Map(); // character -> { readings: [], meanings: [] }
        this.dataLoaded = false;
        
        // Kuroshiro for Japanese text conversion (lazy loaded)
        this.kuroshiro = null;
        this.kuroshiroInitialized = false;
        this.kuroshiroInitializing = false;

        this.reviewOrder = localStorage.getItem('wanikani_review_order') || 'random';
        this.uiLanguage = localStorage.getItem('wanikani_ui_language') || 'en';
        this.practiceModeId = localStorage.getItem('wanikani_practice_mode') || DEFAULT_PRACTICE_MODE_ID;
        this.burnedPracticeCount = PRACTICE_MODES.dueReviewsWithBurned.burnedPracticeCount;

        this.initializeElements();
        this.syncSettingsFormsFromStorage();
        this.initializeSpeechRecognition();
        this.initializeEventListeners();
        this.applyUiLanguageToLiveControls();

        // Start Kuroshiro initialization early (non-blocking)
        this.initializeKuroshiro();

        if (this.apiToken) {
            this.startReviews();
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
            apiSetupDescription: document.getElementById('apiSetupDescription'),
            savedTokenNotice: document.getElementById('savedTokenNotice'),
            editSavedToken: document.getElementById('editSavedToken'),
            apiTokenInputGroup: document.getElementById('apiTokenInputGroup'),
            saveToken: document.getElementById('saveToken'),
            progressFill: document.getElementById('progressFill'),
            progressText: document.getElementById('progressText'),
            burnedProgress: document.getElementById('burnedProgress'),
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
            confirmationButtons: document.getElementById('confirmationButtons'),
            confirmIncorrect: document.getElementById('confirmIncorrect'),
            confirmCorrect: document.getElementById('confirmCorrect'),
            confirmSkip: document.getElementById('confirmSkip'),
            nextQuestion: document.getElementById('nextQuestion'),
            pauseReviews: document.getElementById('pauseReviews'),
            changeApiToken: document.getElementById('changeApiToken'),
            endSession: document.getElementById('endSession'),
            retryButton: document.getElementById('retryButton'),
            errorMessage: document.getElementById('errorMessage'),
            reviewOrder: document.getElementById('reviewOrder'),
            uiLanguage: document.getElementById('uiLanguage'),
            reviewOrderInline: document.getElementById('reviewOrderInline'),
            uiLanguageInline: document.getElementById('uiLanguageInline'),
            practiceMode: document.getElementById('practiceMode'),
            practiceModeInline: document.getElementById('practiceModeInline'),
            practiceModeError: document.getElementById('practiceModeError'),
            startSelectedMode: document.getElementById('startSelectedMode'),
            confirmationPrompt: document.getElementById('confirmationPrompt')
        };
    }

    syncSettingsFormsFromStorage() {
        if (this.elements.reviewOrder) {
            this.elements.reviewOrder.value = this.reviewOrder === 'sequential' ? 'sequential' : 'random';
        }
        if (this.elements.reviewOrderInline) {
            this.elements.reviewOrderInline.value = this.reviewOrder === 'sequential' ? 'sequential' : 'random';
        }
        if (this.elements.uiLanguage) {
            this.elements.uiLanguage.value = this.uiLanguage === 'ja' ? 'ja' : 'en';
        }
        if (this.elements.uiLanguageInline) {
            this.elements.uiLanguageInline.value = this.uiLanguage === 'ja' ? 'ja' : 'en';
        }
        if (this.elements.practiceMode) {
            this.elements.practiceMode.value = getPracticeMode(this.practiceModeId).id;
        }
        if (this.elements.practiceModeInline) {
            this.elements.practiceModeInline.value = getPracticeMode(this.practiceModeId).id;
        }
        if (this.elements.practiceModeError) {
            this.elements.practiceModeError.value = getPracticeMode(this.practiceModeId).id;
        }
    }

    refreshApiSetupTokenState({ editing = false } = {}) {
        const hasSavedToken = Boolean(this.apiToken);
        const showEditor = editing || !hasSavedToken;

        if (this.elements.apiSetupDescription) {
            this.elements.apiSetupDescription.textContent = hasSavedToken && !showEditor
                ? 'Choose a practice mode and start with your saved WaniKani API token:'
                : 'Enter your WaniKani API token to get started:';
        }
        if (this.elements.savedTokenNotice) {
            this.elements.savedTokenNotice.style.display = hasSavedToken && !showEditor ? 'flex' : 'none';
        }
        if (this.elements.apiTokenInputGroup) {
            this.elements.apiTokenInputGroup.style.display = 'flex';
        }
        if (this.elements.saveToken) {
            this.elements.saveToken.textContent = hasSavedToken && !showEditor ? 'Start' : 'Save & Start';
        }
        if (this.elements.apiToken) {
            this.elements.apiToken.style.display = showEditor ? 'block' : 'none';
            this.elements.apiToken.value = '';
            this.elements.apiToken.placeholder = hasSavedToken ? 'Enter a new WaniKani API token' : 'Your WaniKani API token';
        }
    }

    persistReviewOrder(value) {
        this.reviewOrder = value === 'sequential' ? 'sequential' : 'random';
        localStorage.setItem('wanikani_review_order', this.reviewOrder);
        this.syncSettingsFormsFromStorage();
    }

    persistUiLanguage(value) {
        this.uiLanguage = value === 'ja' ? 'ja' : 'en';
        localStorage.setItem('wanikani_ui_language', this.uiLanguage);
        this.syncSettingsFormsFromStorage();
        this.applyUiLanguageToLiveControls();
        if (this.elements.questionText && this.currentQuestionType) {
            this.elements.questionText.textContent = this.getQuestionText(this.currentQuestionType);
        }
        if (this.awaitingSubmitConfirmation) {
            this.refreshSubmitConfirmationLabels();
        }
    }

    persistPracticeMode(value) {
        this.practiceModeId = getPracticeMode(value).id;
        localStorage.setItem('wanikani_practice_mode', this.practiceModeId);
        this.syncSettingsFormsFromStorage();
    }

    isJapaneseUi() {
        return this.uiLanguage === 'ja';
    }

    applyUiLanguageToLiveControls() {
        const ja = this.isJapaneseUi();
        if (this.elements.pauseReviews) {
            this.elements.pauseReviews.textContent = ja
                ? (this.isPaused ? '再開' : '一時停止')
                : (this.isPaused ? 'Resume Reviews' : 'Pause Reviews');
        }
        if (this.elements.changeApiToken) {
            this.elements.changeApiToken.textContent = ja ? 'APIトークンを変更' : 'Change API Token';
        }
        if (this.elements.endSession) {
            this.elements.endSession.textContent = ja ? 'セッション終了' : 'End Session';
        }
        if (!this.isListening && this.elements.startListening) {
            if (this.currentQuestionType === 'reading') {
                this.elements.startListening.textContent = ja ? '🎤 話す（日本語）' : '🎤 Start Speaking (Japanese)';
            } else {
                this.elements.startListening.textContent = ja ? '🎤 話す（英語）' : '🎤 Start Speaking (English)';
            }
        }
        if (this.elements.continuousMode) {
            const on = this.continuousMode;
            this.elements.continuousMode.textContent = ja
                ? (on ? '🔄 連続モード：オン' : '🔄 連続モード：オフ')
                : (on ? '🔄 Continuous Mode: ON' : '🔄 Continuous Mode: OFF');
        }
        if (this.elements.nextQuestion) {
            this.elements.nextQuestion.textContent = ja ? '次へ' : 'Next Question';
        }
    }

    getMicButtonLabel() {
        const ja = this.isJapaneseUi();
        if (this.currentQuestionType === 'reading') {
            return ja ? '🎤 話す（日本語）' : '🎤 Start Speaking (Japanese)';
        }
        return ja ? '🎤 話す（英語）' : '🎤 Start Speaking (English)';
    }

    refreshSubmitConfirmationLabels() {
        if (!this.elements.confirmationPrompt || !this.currentReviewState) return;

        const state = this.currentReviewState;
        const meaningErrors = state.incorrectMeaningCount;
        const readingErrors = state.incorrectReadingCount;
        const isPractice = !state.submitToWanikani;

        if (this.isJapaneseUi()) {
            this.elements.confirmationPrompt.textContent = isPractice
                ? 'この練習結果をローカルに記録しますか？'
                : 'この結果をWaniKaniに送信しますか？';
            this.elements.correctAnswer.textContent = isPractice
                ? `📝 記録しますか？（意味の誤答: ${meaningErrors}、読みの誤答: ${readingErrors}）`
                : `📝 送信しますか？（意味の誤答: ${meaningErrors}、読みの誤答: ${readingErrors}）`;
            this.elements.confirmIncorrect.textContent = isPractice ? 'はい（間違いとして記録）' : 'はい（間違いのまま提出）';
            this.elements.confirmCorrect.textContent = isPractice ? '正解として記録' : '正解として提出';
            this.elements.confirmSkip.textContent = isPractice ? 'いいえ（記録しない）' : 'いいえ（提出しない）';
        } else {
            this.elements.confirmationPrompt.textContent = isPractice
                ? 'Record this practice result locally?'
                : 'Submit this review to WaniKani?';
            this.elements.correctAnswer.textContent = isPractice
                ? `📝 Record practice result? (${meaningErrors} meaning error${meaningErrors !== 1 ? 's' : ''}, ${readingErrors} reading error${readingErrors !== 1 ? 's' : ''})`
                : `📝 Submit review? (${meaningErrors} meaning error${meaningErrors !== 1 ? 's' : ''}, ${readingErrors} reading error${readingErrors !== 1 ? 's' : ''})`;
            this.elements.confirmIncorrect.textContent = isPractice ? 'Yes (record as missed)' : 'Yes (submit with errors)';
            this.elements.confirmCorrect.textContent = isPractice ? 'Record as Correct' : 'Submit as Correct';
            this.elements.confirmSkip.textContent = isPractice ? 'No (don\'t record)' : 'No (skip, don\'t submit)';
        }
    }

    shuffleInPlace(array) {
        for (let i = array.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [array[i], array[j]] = [array[j], array[i]];
        }
        return array;
    }

    interleavePracticeItems(reviewItems, practiceItems) {
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

    /**
     * Speech recognition often outputs Arabic digits instead of mora (e.g. "2" for に).
     * Expand digits to romaji so romajiToHiragana can recover the intended kana.
     */
    normalizeDigitsToRomajiForReading(text) {
        if (!text) return text;
        let s = text.replace(/[０-９]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xff10 + 0x30));
        if (/[\u3040-\u30ff\u3400-\u9faf]/.test(s)) {
            return s;
        }
        const digitRomaji = {
            '0': 'zero',
            '1': 'ichi',
            '2': 'ni',
            '3': 'san',
            '4': 'yon',
            '5': 'go',
            '6': 'roku',
            '7': 'nana',
            '8': 'hachi',
            '9': 'kyuu'
        };
        return s.replace(/\d/g, (d) => digitRomaji[d] || d);
    }

    normalizeFullWidthDigits(text) {
        if (!text) return text;
        return text.replace(/[０-９]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xff10 + 0x30));
    }

    numberToHiragana(numberText) {
        const value = Number.parseInt(numberText, 10);
        if (!Number.isFinite(value) || value < 0 || value > 99) {
            return numberText;
        }

        const ones = {
            0: 'ぜろ',
            1: 'いち',
            2: 'に',
            3: 'さん',
            4: 'よん',
            5: 'ご',
            6: 'ろく',
            7: 'なな',
            8: 'はち',
            9: 'きゅう'
        };

        if (value < 10) {
            return ones[value];
        }

        if (value === 10) {
            return 'じゅう';
        }

        const tens = Math.floor(value / 10);
        const rest = value % 10;
        const tensText = tens === 1 ? 'じゅう' : `${ones[tens]}じゅう`;
        return rest === 0 ? tensText : `${tensText}${ones[rest]}`;
    }

    normalizeNumbersToHiraganaForReading(text) {
        return this.normalizeFullWidthDigits(text).replace(/\d+/g, (digits) => this.numberToHiragana(digits));
    }

    normalizeNumericKanjiCompoundsForReading(text) {
        const monthReadings = {
            1: 'いちがつ',
            2: 'にがつ',
            3: 'さんがつ',
            4: 'しがつ',
            5: 'ごがつ',
            6: 'ろくがつ',
            7: 'しちがつ',
            8: 'はちがつ',
            9: 'くがつ',
            10: 'じゅうがつ',
            11: 'じゅういちがつ',
            12: 'じゅうにがつ'
        };
        const dayReadings = {
            1: 'ついたち',
            2: 'ふつか',
            3: 'みっか',
            4: 'よっか',
            5: 'いつか',
            6: 'むいか',
            7: 'なのか',
            8: 'ようか',
            9: 'ここのか',
            10: 'とおか',
            14: 'じゅうよっか',
            20: 'はつか',
            24: 'にじゅうよっか'
        };
        const personReadings = {
            1: 'ひとり',
            2: 'ふたり',
            4: 'よにん',
            7: 'しちにん',
            9: 'きゅうにん'
        };
        const counterReadings = {
            1: 'ひとつ',
            2: 'ふたつ',
            3: 'みっつ',
            4: 'よっつ',
            5: 'いつつ',
            6: 'むっつ',
            7: 'ななつ',
            8: 'やっつ',
            9: 'ここのつ',
            10: 'とお'
        };

        return this.normalizeFullWidthDigits(text)
            .replace(/\b(\d{1,2})月/g, (match, digits) => monthReadings[Number.parseInt(digits, 10)] || match)
            .replace(/\b(\d{1,2})日/g, (match, digits) => {
                const value = Number.parseInt(digits, 10);
                return dayReadings[value] || `${this.numberToHiragana(digits)}にち`;
            })
            .replace(/\b(\d+)年/g, (match, digits) => `${this.numberToHiragana(digits)}ねん`)
            .replace(/\b(\d+)人/g, (match, digits) => {
                const value = Number.parseInt(digits, 10);
                return personReadings[value] || `${this.numberToHiragana(digits)}にん`;
            })
            .replace(/\b(\d+)つ/g, (match, digits) => counterReadings[Number.parseInt(digits, 10)] || match);
    }

    getReadingAnswerVariants(text) {
        const trimmed = text.trim();
        const variants = [
            trimmed,
            this.normalizeFullWidthDigits(trimmed),
            this.normalizeNumericKanjiCompoundsForReading(trimmed),
            this.normalizeDigitsToRomajiForReading(trimmed),
            this.normalizeNumbersToHiraganaForReading(trimmed)
        ];

        return [...new Set(variants.filter(Boolean))];
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

                // Reset abort counter on successful result
                this.consecutiveAborts = 0;

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
                if (transcript.length < 1) {
                    console.log('Ignoring short utterance:', transcript);
                    return;
                }

                // Check if we're waiting for submission confirmation
                if (this.awaitingSubmitConfirmation) {
                    this.elements.userAnswer.textContent = transcript;
                    this.handleConfirmationVoiceCommand(transcript);
                    return;
                }

                // For Japanese reading questions, convert kanji to hiragana for display
                if (this.currentQuestionType === 'reading') {
                    try {
                        const transcriptForKana = this.normalizeNumericKanjiCompoundsForReading(transcript);
                        const convertedTranscript = await this.convertToHiragana(transcriptForKana);
                        console.log('Converted transcript:', convertedTranscript);
                        const labelIn = transcriptForKana !== transcript ? `${transcript} → ${transcriptForKana}` : transcript;
                        this.elements.userAnswer.textContent = `${labelIn} → ${convertedTranscript}`;
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

                // Clear the listening timeout on any error
                if (this.listeningTimeout) {
                    clearTimeout(this.listeningTimeout);
                    this.listeningTimeout = null;
                }

                // Track consecutive aborts to prevent rapid restart loops
                if (event.error === 'aborted') {
                    this.consecutiveAborts++;
                    console.log('Consecutive aborts:', this.consecutiveAborts);

                    // If too many consecutive aborts, stop completely and show message
                    if (this.consecutiveAborts >= 3) {
                        console.log('Too many consecutive aborts, stopping');
                        this.isListening = false;
                        this.elements.listeningIndicator.style.display = 'none';
                        this.elements.userAnswer.textContent = 'Click "Start Speaking" to begin';
                        this.elements.startListening.textContent = '🎤 Start Speaking';
                        return;
                    }
                    // Don't do anything on abort - let onend handle restart with delay
                    return;
                }

                // Reset abort counter for non-abort errors
                this.consecutiveAborts = 0;

                // Don't show error for no-speech, just silently handle it
                if (event.error === 'no-speech') {
                    console.log('No speech detected, will retry...');
                    // If awaiting confirmation, restart confirmation listening
                    if (this.awaitingSubmitConfirmation) {
                        setTimeout(() => this.startConfirmationListening(), 500);
                        return;
                    }
                } else {
                    this.elements.userAnswer.textContent = `Error: ${event.error}`;
                }
                if (!this.awaitingSubmitConfirmation) {
                    this.stopListening();
                }
            };

            this.recognition.onend = () => {
                console.log('Speech recognition ended');

                // Clear the listening timeout
                if (this.listeningTimeout) {
                    clearTimeout(this.listeningTimeout);
                    this.listeningTimeout = null;
                }

                this.isListening = false;
                this.elements.listeningIndicator.style.display = 'none';

                // If we had consecutive aborts, wait longer before retrying
                if (this.consecutiveAborts >= 2) {
                    console.log('Waiting longer before retry due to consecutive aborts');
                    setTimeout(() => {
                        this.consecutiveAborts = 0; // Reset after waiting
                        if (this.continuousMode && !this.isPaused && !this.answerLocked && !this.awaitingSubmitConfirmation) {
                            this.startListening();
                        }
                    }, 3000);
                    return;
                }

                // If awaiting confirmation, keep listening for commands
                if (this.awaitingSubmitConfirmation) {
                    setTimeout(() => {
                        if (this.awaitingSubmitConfirmation) {
                            this.startConfirmationListening();
                        }
                    }, 500);
                    return;
                }

                // In continuous mode, restart listening instead of stopping
                // But respect paused state and answer lock
                if (this.continuousMode && !this.isPaused && !this.answerLocked) {
                    // Restart listening after a delay
                    setTimeout(() => {
                        if (this.continuousMode && !this.isListening && !this.isPaused && !this.answerLocked) {
                            this.startListening();
                        }
                    }, 1000);
                } else {
                    this.elements.startListening.textContent = this.getMicButtonLabel();
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
        if (this.elements.editSavedToken) {
            this.elements.editSavedToken.addEventListener('click', () => {
                this.refreshApiSetupTokenState({ editing: true });
                this.elements.apiToken?.focus();
            });
        }

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

        // Confirmation buttons for incorrect answers
        if (this.elements.confirmIncorrect) {
            this.elements.confirmIncorrect.addEventListener('click', () => this.confirmAnswer('incorrect'));
        }
        if (this.elements.confirmCorrect) {
            this.elements.confirmCorrect.addEventListener('click', () => this.confirmAnswer('correct'));
        }
        if (this.elements.confirmSkip) {
            this.elements.confirmSkip.addEventListener('click', () => this.confirmAnswer('skip'));
        }

        if (this.elements.reviewOrder) {
            this.elements.reviewOrder.addEventListener('change', (e) => this.persistReviewOrder(e.target.value));
        }
        if (this.elements.uiLanguage) {
            this.elements.uiLanguage.addEventListener('change', (e) => this.persistUiLanguage(e.target.value));
        }
        if (this.elements.reviewOrderInline) {
            this.elements.reviewOrderInline.addEventListener('change', (e) => this.persistReviewOrder(e.target.value));
        }
        if (this.elements.uiLanguageInline) {
            this.elements.uiLanguageInline.addEventListener('change', (e) => this.persistUiLanguage(e.target.value));
        }
        if (this.elements.practiceMode) {
            this.elements.practiceMode.addEventListener('change', (e) => this.persistPracticeMode(e.target.value));
        }
        if (this.elements.practiceModeInline) {
            this.elements.practiceModeInline.addEventListener('change', async (e) => {
                this.persistPracticeMode(e.target.value);
                await this.startReviews();
            });
        }
        if (this.elements.practiceModeError) {
            this.elements.practiceModeError.addEventListener('change', (e) => this.persistPracticeMode(e.target.value));
        }
        if (this.elements.startSelectedMode) {
            this.elements.startSelectedMode.addEventListener('click', async () => {
                if (this.elements.practiceModeError) {
                    this.persistPracticeMode(this.elements.practiceModeError.value);
                }
                await this.startReviews();
            });
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
                dictPath: 'https://cdn.jsdelivr.net/npm/kuromoji@0.1.2/dict/'
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
        const tokenEditorVisible = this.elements.apiToken?.style.display !== 'none';
        const token = tokenEditorVisible ? this.elements.apiToken.value.trim() : this.apiToken;
        if (!token) {
            this.showError('Please enter your API token');
            return;
        }
        
        this.apiToken = token;
        this.apiClient.setApiToken(token);
        localStorage.setItem('wanikani_api_token', token);

        if (this.elements.reviewOrder) {
            this.persistReviewOrder(this.elements.reviewOrder.value);
        }
        if (this.elements.uiLanguage) {
            this.persistUiLanguage(this.elements.uiLanguage.value);
        }
        if (this.elements.practiceMode) {
            this.persistPracticeMode(this.elements.practiceMode.value);
        }

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
        // Legacy compatibility: subject data is now loaded lazily by SubjectStore.
        this.kanjiData = this.subjectStore.getKanjiData();
        this.vocabularyData = this.subjectStore.getVocabularyData();
        this.dataLoaded = true;
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
        this.updateBurnedProgressIndicator();
        this.syncSettingsFormsFromStorage();
        this.refreshApiSetupTokenState();
    }

    showLoading() {
        this.elements.apiSetup.style.display = 'none';
        this.elements.reviewInterface.style.display = 'none';
        this.elements.loading.style.display = 'flex';
        this.elements.error.style.display = 'none';
        this.updateBurnedProgressIndicator();
    }

    showReviews() {
        this.elements.apiSetup.style.display = 'none';
        this.elements.reviewInterface.style.display = 'flex';
        this.elements.loading.style.display = 'none';
        this.elements.error.style.display = 'none';
        this.updateBurnedProgressIndicator();
    }

    showError(message) {
        this.elements.errorMessage.textContent = message;
        this.elements.apiSetup.style.display = 'none';
        this.elements.reviewInterface.style.display = 'none';
        this.elements.loading.style.display = 'none';
        this.elements.error.style.display = 'flex';
        this.updateBurnedProgressIndicator();
    }

    async startReviews() {
        if (this.isListening) {
            this.stopListening();
        }
        this.awaitingSubmitConfirmation = false;
        this.answerLocked = false;
        this.currentReviewState = null;
        this.currentSubject = null;
        this.showLoading();
        
        try {
            await this.fetchReviews();
            if (this.currentReviews.length === 0) {
                const mode = getPracticeMode(this.practiceModeId);
                this.showError(`No items available for ${mode.label}.`);
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
        const mode = getPracticeMode(this.practiceModeId);
        const session = await buildPracticeSession({
            apiClient: this.apiClient,
            subjectStore: this.subjectStore,
            mode,
            reviewOrder: this.reviewOrder,
            burnedPracticeStore: this.burnedPracticeStore
        });

        this.currentSession = session;
        this.currentReviews = session.items;
        this.currentReviewIndex = 0;
        this.totalAvailableReviews = session.totalAvailableItems;
        this.kanjiData = this.subjectStore.getKanjiData();
        this.vocabularyData = this.subjectStore.getVocabularyData();

        await this.subjectStore.prefetchSubjects(this.currentReviews.slice(0, 10).map((item) => item.subjectId));

        console.log(
            `Loaded ${this.currentReviews.length} items for ${mode.label} (${this.reviewOrder})`
        );
    }

    async fetchBurnedPracticeReviews(count) {
        const session = await buildPracticeSession({
            apiClient: this.apiClient,
            subjectStore: this.subjectStore,
            mode: { ...PRACTICE_MODES.burnedPractice, itemLimit: count },
            reviewOrder: this.reviewOrder,
            burnedPracticeStore: this.burnedPracticeStore
        });

        return session.items;
    }

    async fetchSubject(subjectId) {
        const subject = await this.subjectStore.getSubject(subjectId);
        this.kanjiData = this.subjectStore.getKanjiData();
        this.vocabularyData = this.subjectStore.getVocabularyData();
        return subject;
    }

    displayCurrentReview() {
        if (this.currentReviewIndex >= this.currentReviews.length) {
            this.showError('All reviews completed! Great job!');
            return;
        }

        const review = this.currentReviews[this.currentReviewIndex];

        // Initialize review state for this assignment if not already set
        if (!this.currentReviewState || this.currentReviewState.assignmentId !== review.assignmentId) {
            this.currentReviewState = {
                assignmentId: review.assignmentId,
                subjectId: review.subjectId,
                submitToWanikani: review.submitToWanikani,
                practiceOnly: !review.submitToWanikani,
                modeId: review.modeId,
                burnedPracticePhase: review.burnedPracticePhase,
                groupId: review.groupId,
                groupLabel: review.groupLabel,
                groupPosition: review.groupPosition,
                groupSize: review.groupSize,
                questionTypes: review.questionTypes || ['meaning', 'reading'],
                subjectType: null, // Will be set when subject loads
                meaningAnswered: false,
                readingAnswered: false,
                incorrectMeaningCount: 0,
                incorrectReadingCount: 0
            };
        }

        this.currentSubject = null;
        this.loadSubjectData(review.subjectId);
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
            const subjectType = subject.object; // 'radical', 'kanji', or 'vocabulary'
            if (this.currentReviewState) {
                this.currentReviewState.subjectType = subjectType;
            }

            // Set item type text and color class
            console.log('Subject type:', subjectType);
            const typeLabel = subjectType || 'Unknown';
            const modeLabel = getPracticeMode(this.currentReviewState?.modeId).label;
            const groupLabel = this.currentReviewState?.groupSize
                ? `group ${this.currentReviewState.groupPosition}/${this.currentReviewState.groupSize}`
                : null;
            this.elements.itemType.textContent = this.currentReviewState?.practiceOnly
                ? `${typeLabel} (${[modeLabel, groupLabel].filter(Boolean).join(' · ')})`
                : typeLabel;
            this.elements.itemType.className = 'item-type ' + (subjectType || '');
            this.elements.itemCharacter.className = 'item-character ' + (subjectType || '');
            console.log('Item character class:', this.elements.itemCharacter.className);

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
        // Only speak in continuous mode
        if (!this.continuousMode) {
            return;
        }

        // Get subject type for speech (shorten "vocabulary" to "vocab" for English TTS)
        let subjectType = this.currentReviewState?.subjectType || '';
        const subjectTypeForJa = subjectType;
        if (subjectType === 'vocabulary') {
            subjectType = 'vocab';
        }

        let text;
        let lang = 'en-US';
        if (this.isJapaneseUi()) {
            const typeMap = { radical: '部首', kanji: '漢字', vocabulary: '単語' };
            const subjectJa = typeMap[subjectTypeForJa] || '';
            const qJa = questionType === 'meaning' ? '意味' : '読み';
            text = subjectJa ? `${subjectJa}の${qJa}` : qJa;
            lang = 'ja-JP';
        } else {
            const questionWord = questionType === 'meaning' ? 'meaning' : 'reading';
            text = subjectType ? `${subjectType} ${questionWord}` : questionWord;
        }
        console.log('Speaking question type:', text);

        // Speak the question type, then start listening when complete
        this.speak(text, () => {
            console.log('Question type speech complete, starting listening');
            // Add a small buffer after speech ends
            setTimeout(() => {
                if (this.continuousMode && !this.isPaused && !this.isListening && !this.answerLocked) {
                    this.startListening();
                }
            }, 300);
        }, lang);
    }

    determineQuestionType() {
        const state = this.currentReviewState;

        if (!state) {
            return 'meaning'; // Default fallback
        }

        // Radicals only have meanings, no readings
        const isRadical = state.subjectType === 'radical';
        const allowedQuestionTypes = state.questionTypes || ['meaning', 'reading'];

        // If meaning not yet answered, ask meaning first
        if (allowedQuestionTypes.includes('meaning') && !state.meaningAnswered) {
            return 'meaning';
        }

        // If reading not yet answered and this subject has readings (not a radical)
        if (allowedQuestionTypes.includes('reading') && !state.readingAnswered && !isRadical) {
            return 'reading';
        }

        // Both answered (or radical with only meaning) - this shouldn't happen
        // as we should have moved to next question, but return meaning as fallback
        return 'meaning';
    }

    getQuestionText(questionType) {
        if (this.isJapaneseUi()) {
            switch (questionType) {
                case 'meaning':
                    return 'この項目の意味はなんですか。';
                case 'reading':
                    return 'この項目の読みはなんですか。';
                default:
                    return '答えはなんですか。';
            }
        }
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
        console.log('Speaking:', text, 'lang:', lang);

        // Cancel any stuck/pending speech first (Chrome bug workaround)
        this.synthesis.cancel();

        // Ensure voices are loaded
        let voices = this.synthesis.getVoices();
        if (voices.length === 0) {
            // Voices not loaded yet, wait for them
            this.synthesis.onvoiceschanged = () => {
                voices = this.synthesis.getVoices();
                this.doSpeak(text, lang, onComplete);
            };
            return;
        }

        this.doSpeak(text, lang, onComplete);
    }

    doSpeak(text, lang, onComplete) {
        const utterance = new SpeechSynthesisUtterance(text);
        utterance.lang = lang;
        utterance.rate = 0.8;
        utterance.pitch = 1;
        utterance.volume = 1;

        // Track if speech completed to avoid double-calling onComplete
        let completed = false;
        const markComplete = () => {
            if (!completed) {
                completed = true;
                if (onComplete) onComplete();
            }
        };

        // Log when speech actually starts
        utterance.onstart = () => {
            console.log('Speech started:', text);
        };

        utterance.onerror = (event) => {
            console.error('Speech synthesis error:', event.error);
            markComplete();
        };

        utterance.onend = () => {
            console.log('Speech ended:', text);
            markComplete();
        };

        this.synthesis.speak(utterance);

        // Fallback: if speech doesn't complete in 5 seconds, assume it's done/stuck
        setTimeout(() => {
            if (!completed && !this.synthesis.speaking) {
                console.log('Speech fallback timeout - synthesis not speaking');
                markComplete();
            }
        }, 5000);
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
            button.className = 'btn btn-secondary active';
            // Start continuous listening if not already listening
            if (!this.isListening) {
                this.startListening();
            }
        } else {
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
        this.applyUiLanguageToLiveControls();
    }

    startListening() {
        if (!this.recognition) {
            this.showError('Speech recognition is not supported in your browser');
            return;
        }

        // Don't start listening while speech synthesis is playing
        // But limit retries to avoid getting stuck if synthesis.speaking is stuck
        if (this.synthesis.speaking) {
            this.synthesisWaitCount = (this.synthesisWaitCount || 0) + 1;
            if (this.synthesisWaitCount < 6) { // Max 3 seconds of waiting (6 * 500ms)
                console.log('Speech synthesis still playing, delaying recognition start (attempt', this.synthesisWaitCount, ')');
                setTimeout(() => {
                    if (this.continuousMode && !this.isPaused && !this.answerLocked) {
                        this.startListening();
                    }
                }, 500);
                return;
            } else {
                console.log('Synthesis stuck, canceling and proceeding');
                this.synthesis.cancel();
                this.synthesisWaitCount = 0;
            }
        } else {
            this.synthesisWaitCount = 0;
        }

        // Prevent rapid restarts
        const now = Date.now();
        const timeSinceLastStart = now - this.lastRecognitionStartTime;
        if (timeSinceLastStart < 500 && this.isListening) {
            console.log('Ignoring rapid restart attempt');
            return;
        }
        this.lastRecognitionStartTime = now;

        // Set language based on question type
        if (this.currentQuestionType === 'reading') {
            this.recognition.lang = 'ja-JP'; // Japanese for readings
            console.log('Set speech recognition to Japanese for reading question');
        } else {
            this.recognition.lang = 'en-US'; // English for meanings
            console.log('Set speech recognition to English for meaning question');
        }
        this.elements.startListening.textContent = this.getMicButtonLabel();

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

        try {
            this.recognition.start();
        } catch (e) {
            console.log('Recognition start error:', e.message);
            // If already started, just ignore
            if (e.message && e.message.includes('already started')) {
                return;
            }
            // Otherwise retry after a delay
            setTimeout(() => {
                if (this.continuousMode && !this.isPaused && !this.answerLocked) {
                    this.startListening();
                }
            }, 1000);
        }
    }

    stopListening() {
        console.log('Stopping speech recognition...');
        this.isListening = false;
        // Don't reset continuousMode here - it should only be toggled by the user
        this.elements.listeningIndicator.style.display = 'none';
        
        this.elements.startListening.textContent = this.getMicButtonLabel();
        
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

        // Always record the answer
        this.recordAnswer(isCorrect);

        // Show result - checkAndSubmitReview will be called after speech completes
        this.showResult(isCorrect, userAnswer, correctAnswers);
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
        const allowedQuestionTypes = state.questionTypes || ['meaning', 'reading'];

        if (allowedQuestionTypes.includes('meaning') && !state.meaningAnswered) {
            return false;
        }

        if (allowedQuestionTypes.includes('reading') && !isRadical && !state.readingAnswered) {
            return false;
        }

        return true;
    }

    async checkAndSubmitReview() {
        if (!this.isReviewComplete()) {
            return;
        }

        const state = this.currentReviewState;
        const hasIncorrectAnswers = state.incorrectMeaningCount > 0 || state.incorrectReadingCount > 0;

        if (hasIncorrectAnswers) {
            // Show confirmation before submitting
            console.log('Review has incorrect answers, awaiting confirmation...');
            this.showSubmitConfirmation();
        } else {
            // All correct, submit immediately
            console.log('Review complete with all correct, submitting to WaniKani...');
            await this.submitReview();
        }
    }

    showSubmitConfirmation() {
        this.awaitingSubmitConfirmation = true;
        this.answerLocked = true;

        this.refreshSubmitConfirmationLabels();
        this.elements.confirmationButtons.style.display = 'block';
        this.elements.nextQuestion.style.display = 'none';

        // Only speak and listen in continuous mode
        if (this.continuousMode) {
            console.log('Showing submit confirmation, speaking prompt...');
            const isPractice = !this.currentReviewState?.submitToWanikani;
            const prompt = this.isJapaneseUi()
                ? (isPractice ? '間違いとして記録しますか。' : '間違いのまま提出しますか。')
                : (isPractice ? 'Record as missed?' : 'Submit incorrect?');
            const lang = this.isJapaneseUi() ? 'ja-JP' : 'en-US';
            this.speak(prompt, () => {
                console.log('Confirmation prompt speech complete, starting listening');
                setTimeout(() => this.startConfirmationListening(), 300);
            }, lang);
        }
    }

    startConfirmationListening() {
        if (!this.recognition) return;
        if (!this.awaitingSubmitConfirmation) return;

        // Prevent rapid restarts
        const now = Date.now();
        const timeSinceLastStart = now - this.lastRecognitionStartTime;
        if (timeSinceLastStart < 500) {
            console.log('Ignoring rapid confirmation listening restart');
            setTimeout(() => this.startConfirmationListening(), 500);
            return;
        }

        this.recognition.lang = this.isJapaneseUi() ? 'ja-JP' : 'en-US';
        console.log('Listening for confirmation command...');
        this.elements.userAnswer.textContent = this.isJapaneseUi()
            ? '「はい」「いいえ」「正解として提出」のいずれかで答えてください。'
            : 'Listening for: "yes", "no", or "submit correct"...';

        // Small delay before starting to avoid conflicts
        setTimeout(() => {
            if (this.awaitingSubmitConfirmation) {
                this.lastRecognitionStartTime = Date.now();
                try {
                    this.recognition.start();
                } catch (e) {
                    console.log('Recognition start error:', e.message);
                    // If already started, just ignore
                    if (e.message && e.message.includes('already started')) {
                        return;
                    }
                    // Retry after a longer delay
                    setTimeout(() => this.startConfirmationListening(), 1000);
                }
            }
        }, 100);
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
        const prepared = this.normalizeDigitsToRomajiForReading(text);
        const romaji = prepared.toLowerCase();

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

        console.log(`Romaji to hiragana: "${prepared}" -> "${result}"`);
        return result;
    }

    cleanMeaningAnswer(text) {
        return text
            .normalize('NFKC')
            .toLowerCase()
            .replace(/[\u2010-\u2015\u2212\uFE58\uFE63\uFF0D]/g, '-')
            .replace(/[\u2018\u2019\u201A\u201B\u2032\uFF07]/g, "'")
            .replace(/[\u201C\u201D\u201E\u201F\u2033\uFF02]/g, '"')
            .replace(/[^\p{L}\p{N}'"-]+/gu, ' ')
            .trim()
            .replace(/\s+/g, ' ');
    }

    optimalStringAlignmentDistance(left, right, maxDistance = Infinity) {
        if (left === right) return 0;
        if (!left.length) return right.length;
        if (!right.length) return left.length;

        const previousPrevious = new Array(right.length + 1).fill(0);
        let previous = Array.from({ length: right.length + 1 }, (_, index) => index);

        for (let i = 1; i <= left.length; i++) {
            const current = new Array(right.length + 1);
            current[0] = i;
            let rowMinimum = current[0];

            for (let j = 1; j <= right.length; j++) {
                const cost = left[i - 1] === right[j - 1] ? 0 : 1;
                current[j] = Math.min(
                    previous[j] + 1,
                    current[j - 1] + 1,
                    previous[j - 1] + cost
                );

                if (
                    i > 1 &&
                    j > 1 &&
                    left[i - 1] === right[j - 2] &&
                    left[i - 2] === right[j - 1]
                ) {
                    current[j] = Math.min(current[j], previousPrevious[j - 2] + 1);
                }

                rowMinimum = Math.min(rowMinimum, current[j]);
            }

            if (rowMinimum > maxDistance) {
                return maxDistance + 1;
            }

            previousPrevious.splice(0, previousPrevious.length, ...previous);
            previous = current;
        }

        return previous[right.length];
    }

    meaningTypoThreshold(reference) {
        const length = reference.length;
        if (length <= 3) return 0;
        if (length <= 5) return 1;
        if (length <= 7) return 2;
        return Math.floor(length / 7) + 2;
    }

    fuzzyMeaningMatches(userAnswer, correctAnswer) {
        const cleanUserAnswer = this.cleanMeaningAnswer(userAnswer);
        const cleanCorrectAnswer = this.cleanMeaningAnswer(correctAnswer);
        const threshold = this.meaningTypoThreshold(cleanCorrectAnswer);

        if (!cleanUserAnswer || !cleanCorrectAnswer) {
            return false;
        }

        const distance = this.optimalStringAlignmentDistance(cleanUserAnswer, cleanCorrectAnswer, threshold);
        return distance <= threshold;
    }

    async checkAnswer(userAnswer, correctAnswers) {
        const trimmed = userAnswer.trim();
        const isReading = this.currentQuestionType === 'reading';
        const answerVariants = isReading ? this.getReadingAnswerVariants(trimmed) : [trimmed];
        const normalizedUserAnswer = answerVariants[0].toLowerCase().trim();

        if (isReading && this.currentSubject?.characters && answerVariants.includes(this.currentSubject.characters)) {
            console.log('Accepting reading because transcript matched current subject characters exactly');
            return true;
        }

        // Check direct matches first
        for (const correctAnswer of correctAnswers) {
            const normalizedCorrect = correctAnswer.toLowerCase().trim();

            // Direct match
            if (answerVariants.some((answerVariant) => answerVariant.toLowerCase().trim() === normalizedCorrect)) {
                return true;
            }

            // For Japanese readings, handle katakana and kanji to hiragana conversion
            if (isReading) {
                for (const answerForCompare of answerVariants) {
                    // Check direct match (preserve hiragana/katakana)
                    if (answerForCompare === correctAnswer) {
                        return true;
                    }

                    // Convert katakana to hiragana
                    const userAsHiragana = this.katakanaToHiragana(answerForCompare);
                    if (userAsHiragana === correctAnswer) {
                        return true;
                    }

                    // Convert user's kanji answer to hiragana for comparison
                    const userHiragana = await this.convertToHiragana(answerForCompare);
                    if (userHiragana === correctAnswer) {
                        return true;
                    }

                    // Also try converting the kanji result through katakana to hiragana
                    const userHiraganaFromKatakana = this.katakanaToHiragana(userHiragana);
                    if (userHiraganaFromKatakana === correctAnswer) {
                        return true;
                    }

                    // Try converting romaji to hiragana (variants expand misheard digits, e.g. "2" → "ni")
                    const userFromRomaji = this.romajiToHiragana(answerForCompare);
                    if (userFromRomaji === correctAnswer) {
                        return true;
                    }
                }
            }

            // Check for partial matches
            if (answerVariants.some((answerVariant) => {
                const normalizedVariant = answerVariant.toLowerCase().trim();
                return normalizedVariant.includes(normalizedCorrect) ||
                    normalizedCorrect.includes(normalizedVariant);
            })) {
                return true;
            }

            if (!isReading && this.fuzzyMeaningMatches(trimmed, correctAnswer)) {
                console.log(`Accepting fuzzy meaning match: "${trimmed}" ≈ "${correctAnswer}"`);
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
        this.elements.confirmationButtons.style.display = 'none';
        this.elements.nextQuestion.style.display = 'block';

        // Reset confirmation state - only set to true when full review is complete with errors
        this.awaitingSubmitConfirmation = false;

        const correctAnswerText = correctAnswers.join(', ');
        console.log('Correct answers for display:', correctAnswers);
        console.log('Question type:', this.currentQuestionType);
        console.log('Review complete?', this.isReviewComplete());

        if (isCorrect) {
            this.elements.resultMessage.textContent = this.isJapaneseUi() ? '✅ 正解！' : '✅ Correct!';
            this.elements.resultMessage.className = 'result-message correct';

            // Speak "Correct" followed by the answer (only in continuous mode)
            if (this.continuousMode) {
                if (this.isJapaneseUi()) {
                    this.speak(`正解。${correctAnswerText}`, () => this.handlePostAnswer(), 'ja-JP');
                } else if (this.currentQuestionType === 'reading') {
                    this.speak(`正解。${correctAnswerText}`, () => this.handlePostAnswer(), 'ja-JP');
                } else {
                    this.speak(`Correct. ${correctAnswerText}`, () => this.handlePostAnswer());
                }
            } else {
                this.handlePostAnswer();
            }
        } else {
            this.elements.resultMessage.textContent = this.isJapaneseUi()
                ? `❌ ちがいます。正解は ${correctAnswerText} です。`
                : `❌ Incorrect: the answer is ${correctAnswerText}`;
            this.elements.resultMessage.className = 'result-message incorrect';
            this.elements.correctAnswer.textContent = '';

            // Speak the feedback with the correct answer (only in continuous mode)
            if (this.continuousMode) {
                if (this.isJapaneseUi()) {
                    const wrongSpeech = this.currentQuestionType === 'reading'
                        ? `ちがいます。正解は${correctAnswerText}です。`
                        : `ちがいます。正解は${correctAnswers.join('、または、')}です。`;
                    this.speak(wrongSpeech, () => this.handlePostAnswer(), 'ja-JP');
                } else if (this.currentQuestionType === 'reading') {
                    this.speak(`ちがいます。正解は${correctAnswerText}です。`, () => this.handlePostAnswer(), 'ja-JP');
                } else {
                    this.speak(`Incorrect. The correct answer is ${correctAnswers.join(' or ')}`, () => this.handlePostAnswer());
                }
            } else {
                this.handlePostAnswer();
            }
        }
    }

    async handlePostAnswer() {
        // Add a small buffer after speech ends before proceeding
        await new Promise(resolve => setTimeout(resolve, 300));

        // Check if review is complete and needs confirmation
        if (this.isReviewComplete()) {
            await this.completeCurrentItem();
            return;
        }

        // Not complete yet, auto-advance in continuous mode
        console.log('Review not complete, continuous mode:', this.continuousMode);
        if (this.continuousMode) {
            console.log('Auto-advancing to next question');
            this.nextQuestion();
        }
    }

    hasIncorrectAnswers() {
        const state = this.currentReviewState;
        return Boolean(state && (state.incorrectMeaningCount > 0 || state.incorrectReadingCount > 0));
    }

    async advanceToNextItem() {
        this.currentReviewIndex++;
        this.currentReviewState = null;
        this.answerLocked = false;

        const nextItem = this.currentReviews[this.currentReviewIndex];
        if (nextItem?.subjectId) {
            this.subjectStore.prefetchSubjects([nextItem.subjectId]);
        }

        this.displayCurrentReview();
    }

    async completeCurrentItem({ forceCorrect = false, skipSubmission = false, allowIncorrectSubmission = false } = {}) {
        const state = this.currentReviewState;
        if (!state || !this.isReviewComplete()) {
            return;
        }

        const hadIncorrectAnswers = this.hasIncorrectAnswers();

        if (forceCorrect) {
            state.incorrectMeaningCount = 0;
            state.incorrectReadingCount = 0;
        }

        if (!state.submitToWanikani) {
            if (hadIncorrectAnswers && !forceCorrect && !skipSubmission && !allowIncorrectSubmission) {
                console.log('Practice item has incorrect answers, showing local record confirmation...');
                this.showSubmitConfirmation();
                return;
            }

            if (!skipSubmission) {
                this.burnedPracticeStore.recordAttempt({
                    subjectId: state.subjectId,
                    modeId: state.modeId,
                    reviewPhase: state.burnedPracticePhase,
                    isCorrect: !hadIncorrectAnswers || forceCorrect,
                    incorrectMeaningCount: state.incorrectMeaningCount,
                    incorrectReadingCount: state.incorrectReadingCount
                });
            }
            console.log('Practice item complete or submission skipped, advancing');
            await this.advanceToNextItem();
            return;
        }

        if (skipSubmission) {
            console.log('Skipping WaniKani submission, advancing');
            await this.advanceToNextItem();
            return;
        }

        if (this.hasIncorrectAnswers() && !forceCorrect && !allowIncorrectSubmission) {
            console.log('Review has incorrect answers, showing confirmation...');
            this.showSubmitConfirmation();
            return;
        }

        console.log('Review complete, submitting to WaniKani...');
        try {
            await this.submitReview();
            await this.advanceToNextItem();
        } catch (error) {
            console.error('Failed to submit review, staying on current item:', error);
            this.answerLocked = false;
            this.elements.resultMessage.textContent = 'Failed to submit to WaniKani. Please try again.';
            this.elements.resultMessage.className = 'result-message incorrect';
            this.elements.nextQuestion.style.display = 'block';
        }
    }

    handleConfirmationVoiceCommand(transcript) {
        console.log('Processing confirmation voice command:', transcript);

        const raw = transcript.trim();
        const command = raw.toLowerCase();

        if (this.isJapaneseUi()) {
            const submitCorrectHints = [
                '正解として提出',
                '正解としてていしゅつ',
                '正解で提出',
                '正解として送る',
                'すべて正解',
                '全部正解'
            ];
            for (const phrase of submitCorrectHints) {
                if (raw.includes(phrase)) {
                    this.confirmAnswer('correct');
                    return;
                }
            }
            if (raw.includes('いいえ')) {
                this.confirmAnswer('skip');
                return;
            }
            if (raw === 'はい' || raw.startsWith('はい')) {
                this.confirmAnswer('incorrect');
                return;
            }
            console.log('Unrecognized confirmation command:', command);
            this.elements.userAnswer.textContent =
                `「${transcript}」—「はい」「いいえ」「正解として提出」のいずれかで答えてください。`;
            return;
        }

        if (command.includes('submit correct') || command.includes('submit as correct')) {
            this.confirmAnswer('correct');
            return;
        }
        if (command === 'yes' || /^yes\b/.test(command)) {
            this.confirmAnswer('incorrect');
            return;
        }
        if (command === 'no' || /^no\b/.test(command)) {
            this.confirmAnswer('skip');
            return;
        }

        console.log('Unrecognized confirmation command:', command);
        this.elements.userAnswer.textContent =
            `"${transcript}" — Say "yes", "no", or "submit correct".`;

        // The onend handler will automatically restart listening
    }

    async confirmAnswer(choice) {
        console.log('User confirmed submission:', choice);

        // Clear confirmation state
        this.awaitingSubmitConfirmation = false;
        this.stopListening();

        // Hide confirmation buttons
        this.elements.confirmationButtons.style.display = 'none';
        this.elements.nextQuestion.style.display = 'block';

        switch (choice) {
            case 'incorrect':
                await this.completeCurrentItem({ allowIncorrectSubmission: true });
                break;

            case 'correct':
                await this.completeCurrentItem({ forceCorrect: true });
                break;

            case 'skip':
                await this.completeCurrentItem({ skipSubmission: true });
                break;
        }
    }

    async submitReview() {
        if (!this.currentReviewState) {
            console.error('No review state to submit');
            return;
        }

        if (!this.currentReviewState.submitToWanikani) {
            console.log('Skipping WaniKani submission for practice item');
            return;
        }

        // Check if user chose to skip this item
        if (this.currentReviewState.skipSubmission) {
            console.log('Skipping submission for this item (user requested skip)');
            return;
        }

        const state = this.currentReviewState;
        await this.apiClient.submitReview(
            state.assignmentId,
            state.incorrectMeaningCount,
            state.incorrectReadingCount
        );
        console.log('Review submitted successfully');
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
            this.completeCurrentItem();
        }
    }

    togglePause() {
        this.isPaused = !this.isPaused;
        this.applyUiLanguageToLiveControls();

        if (this.isPaused) {
            // Stop listening when paused
            this.stopListening();
            const msg = this.isJapaneseUi() ? '一時停止しました' : 'Reviews paused';
            this.speak(msg, null, this.isJapaneseUi() ? 'ja-JP' : 'en-US');
        } else {
            const msg = this.isJapaneseUi() ? '再開しました' : 'Reviews resumed';
            this.speak(msg, null, this.isJapaneseUi() ? 'ja-JP' : 'en-US');
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
            this.currentSession = null;
            this.currentReviews = [];
            this.currentReviewIndex = 0;
            this.currentReviewState = null;
            this.showApiSetup();
            this.speak('Review session ended');
        }
    }

    clearCache() {
        localStorage.removeItem('wanikani_data_cache');
        localStorage.removeItem('wanikani_data_timestamp');
        this.subjectStore.clear();
        this.kanjiData.clear();
        this.vocabularyData.clear();
        this.dataLoaded = false;
        console.log('Wanikani data cache cleared');
    }

    retry() {
        // Go back to API setup so user can re-enter token
        this.showApiSetup();
    }

    updateProgress() {
        const progress = ((this.currentReviewIndex + 1) / this.currentReviews.length) * 100;
        this.elements.progressFill.style.width = `${progress}%`;
        this.updateBurnedProgressIndicator();

        // Show which part of the review we're on
        let questionPart = '';
        if (this.currentReviewState) {
            const isRadical = this.currentReviewState.subjectType === 'radical';
            const allowedQuestionTypes = this.currentReviewState.questionTypes || ['meaning', 'reading'];
            if (allowedQuestionTypes.includes('meaning') && !this.currentReviewState.meaningAnswered) {
                questionPart = isRadical ? '' : (this.isJapaneseUi() ? '（意味）' : ' (meaning)');
            } else if (allowedQuestionTypes.includes('reading') && !this.currentReviewState.readingAnswered && !isRadical) {
                questionPart = this.isJapaneseUi() ? '（読み）' : ' (reading)';
            }
            if (this.currentReviewState.practiceOnly) {
                const modeLabel = getPracticeMode(this.currentReviewState.modeId).label;
                questionPart += this.isJapaneseUi() ? `（${modeLabel}）` : ` (${modeLabel})`;
            }
            if (this.currentReviewState.groupSize) {
                const groupText = this.isJapaneseUi()
                    ? `グループ ${this.currentReviewState.groupPosition}/${this.currentReviewState.groupSize}`
                    : `group ${this.currentReviewState.groupPosition}/${this.currentReviewState.groupSize}`;
                questionPart += this.isJapaneseUi() ? `（${groupText}）` : ` (${groupText})`;
            }
        }

        // Show progress with total available if more than loaded
        let progressText = `${this.currentReviewIndex + 1} / ${this.currentReviews.length}`;
        if (this.totalAvailableReviews && this.totalAvailableReviews > this.currentReviews.length) {
            progressText += ` (${this.totalAvailableReviews} total)`;
        }
        this.elements.progressText.textContent = progressText + questionPart;
    }

    updateBurnedProgressIndicator() {
        if (!this.elements.burnedProgress) {
            return;
        }

        const isBurnedPractice = this.currentSession?.mode?.id === 'burnedPractice';
        if (!isBurnedPractice || this.elements.reviewInterface.style.display === 'none') {
            this.elements.burnedProgress.style.display = 'none';
            this.elements.burnedProgress.textContent = '';
            return;
        }

        const progress = this.burnedPracticeStore.getProgressSnapshot();
        const currentPhase = this.currentReviewState?.burnedPracticePhase || progress.phase;
        const phaseLabel = currentPhase === 'retry'
            ? (this.isJapaneseUi() ? 'フォローアップ' : 'Follow-up reviews')
            : (this.isJapaneseUi() ? '初回チェック' : 'Initial pass');
        const fullPassText = this.isJapaneseUi()
            ? `全体 ${progress.fullPassCompleted} / ${progress.fullPassTotal}`
            : `Global ${progress.fullPassCompleted} / ${progress.fullPassTotal}`;
        const retryText = progress.retryReviewsRemaining > 0
            ? (this.isJapaneseUi()
                ? `復習 ${progress.retryReviewsRemaining} 回（${progress.retrySubjectCount} 項目）`
                : `${progress.retryReviewsRemaining} follow-up reps across ${progress.retrySubjectCount} item${progress.retrySubjectCount === 1 ? '' : 's'}`)
            : (this.isJapaneseUi() ? '復習待ちなし' : 'no follow-ups queued');

        this.elements.burnedProgress.innerHTML = `<span class="phase">${phaseLabel}</span> · ${fullPassText} · ${retryText}`;
        this.elements.burnedProgress.style.display = 'block';
    }

    resetAnswerSection() {
        this.elements.resultSection.style.display = 'none';
        this.elements.userAnswer.textContent = '';
        this.elements.correctAnswer.textContent = '';
        this.elements.confirmationButtons.style.display = 'none';
        this.elements.nextQuestion.style.display = 'block';

        // Unlock answer evaluation for new question
        this.answerLocked = false;
        this.awaitingSubmitConfirmation = false;

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
