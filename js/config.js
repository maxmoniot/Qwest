// ============================================
// MODULE: CONFIGURATION
// Description: Variables globales et configuration de l'application
// ============================================

(function() {
    'use strict';

    // Configuration générale
    const CONFIG = {
        MAX_QUESTIONS: 150,
        DEFAULT_TIME: 30,
        MIN_TIME: 5,
        MAX_TIME: 300,
        // Hash SHA-256 du mot de passe professeur (prof123)
        TEACHER_PASSWORD_HASH: '00624b02e1f9b996a3278f559d5d55313552ad2c0bafc82adfd975c12df61eaf',
        MAX_QUIZ_NAME_LENGTH: 50,
        RECONNECT_TIMEOUT: 30000, // 30 secondes
        PING_INTERVAL: 10000 // 10 secondes (était 5) - Pour connexions lentes
    };

    // État de l'application
    const APP_STATE = {
        currentPage: 'home',
        currentQuiz: null,
        questions: [],
        editingQuestionIndex: null,
        isTeacher: false,
        currentPlayCode: null,
        currentModifyCode: null,
        isEditingQuestions: false  // Flag pour savoir si on édite activement (pas juste chargé)
    };

    // Types de questions
    const QUESTION_TYPES = {
        MULTIPLE: 'multiple',
        TRUEFALSE: 'truefalse',
        ORDER: 'order',
        FREETEXT: 'freetext'
    };

    // Structure d'une question
    class Question {
        constructor(type) {
            this.id = generateId();
            this.type = type;
            this.question = '';
            this.time = CONFIG.DEFAULT_TIME;
            
            switch(type) {
                case QUESTION_TYPES.MULTIPLE:
                    this.answers = [
                        { text: '', correct: true },
                        { text: '', correct: false },
                        { text: '', correct: false },
                        { text: '', correct: false }
                    ];
                    break;
                    
                case QUESTION_TYPES.TRUEFALSE:
                    this.answers = [
                        { text: 'Vrai', correct: true },
                        { text: 'Faux', correct: false }
                    ];
                    break;
                    
                case QUESTION_TYPES.ORDER:
                    this.answers = [
                        { text: '', order: 1 },
                        { text: '', order: 2 },
                        { text: '', order: 3 },
                        { text: '', order: 4 }
                    ];
                    break;
                    
                case QUESTION_TYPES.FREETEXT:
                    this.answers = [
                        { text: '', correct: true }
                    ];
                    this.caseSensitive = false;
                    this.acceptedAnswers = [];
                    break;
            }
        }
    }

    // Structure d'un quiz
    class Quiz {
        constructor() {
            this.id = generateId();
            this.name = '';
            this.questions = [];
            this.modifyCode = '';
            this.playCode = '';
            this.createdAt = Date.now();
            this.lastModified = Date.now();
        }
    }

    // Générer un ID unique
    function generateId() {
        return Date.now().toString(36) + Math.random().toString(36).substr(2, 9);
    }

    // Exporter vers le scope global
    window.CONFIG = CONFIG;
    window.APP_STATE = APP_STATE;
    window.QUESTION_TYPES = QUESTION_TYPES;
    window.Question = Question;
    window.Quiz = Quiz;
    window.generateId = generateId;

})();
