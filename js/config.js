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

        // === Synchronisation temps réel ===
        // Cadences de polling adaptatives côté élève. Dimensionnées pour rester sous
        // ~800 req/min serveur à 20 élèves + 1 prof + 1 projection derrière un NAT
        // partagé (collège) — sinon l'hébergeur mutualisé bannit l'IP source.
        // Cadences ÉLARGIES (2,5 s) pour baisser le volume agrégé et lisser les pics au
        // démarrage / aux transitions : à 25 élèves × plusieurs classes parfois en
        // simultané, le seuil OVH (~1000 req/min PAR COMPTE) était dépassé en pic. Le
        // milieu d'une question ne change pas → 2,5 s suffit ; la détection des transitions
        // (apparition/fin de question) reste rapide via la fenêtre de transition + le
        // countdown aligné. 2 500 ms × 25 ≈ 600 req/min/classe (au lieu de ~750).
        // SYNCHRO v2 : l'affichage est piloté par l'HORLOGE (révélation à revealAt), plus
        // par la vitesse de polling → on peut RALENTIR le polling sans dégrader la synchro
        // (vérifié : S2 reste ~0,05 s). Objectif : faire chuter le PIC req/min PAR IP (toute
        // la classe sort par une seule IP au collège → c'est l'agrégat par IP qui fait bannir).
        POLL_INTERVAL_QUESTION:   3000,   // ms — pendant qu'une question est active (détection de complétion, pas l'affichage)
        POLL_INTERVAL_IDLE:       5000,   // ms — résultats / Top 3 / finished
        // Salle d'attente : 2,5 s (< FIRST_QUESTION_COUNTDOWN_MS pour que tous aient pollé
        // avant la révélation alignée de Q0). Couplé au countdown aligné serveur, décalage
        // 1ʳᵉ question < 1 s. Lobby bref → volume maîtrisé.
        POLL_INTERVAL_LOBBY:      3000,   // ms — état "waiting" (salle d'attente) ; < FIRST_REVEAL_LEAD_MS
        // Countdown de la 1ʳᵉ question, ALIGNÉ sur l'horloge serveur : tous les clients
        // affichent Q0 à questionStartTime + ce délai (même instant absolu), quel que
        // soit le moment où ils ont pollé. Doit être >= POLL_INTERVAL_LOBBY + marge pour
        // garantir que chaque élève a pollé au moins une fois avant l'échéance.
        FIRST_QUESTION_COUNTDOWN_MS: 3500,
        // Délai de révélation des questions SUIVANTES (Q1+) — utilisé par la projection
        // pour ne JAMAIS devancer les téléphones (le tableau révèle à questionStartTime +
        // ce délai, comme l'élève moyen qui détecte via la fenêtre de transition).
        REVEAL_DELAY_MS:          1500,

        // ============================================================
        // === HORLOGE SERVEUR SYNCHRONISÉE (refonte synchro v2) ===
        // ============================================================
        // Principe : tous les postes synchronisent leur horloge sur celle du SERVEUR
        // (pas un serveur de temps externe — notre propre PHP, joignable à chaque
        // requête, immunisé contre une horloge d'appareil décalée). Le serveur annonce
        // l'instant ABSOLU (ms serveur) d'apparition de chaque question (`revealAt`) ;
        // chaque poste révèle quand SON horloge synchronisée atteint cet instant —
        // donc tous au même moment, SANS requête supplémentaire pour rester synchros.
        //
        // Handshake d'horloge (algo de Cristian) : N aller-retours `time_sync`, on
        // retient l'échantillon de plus faible RTT → offset = serverMs + RTT/2 - reçuMs.
        CLOCK_SYNC_SAMPLES:        5,       // aller-retours par resynchronisation
        CLOCK_SYNC_INTERVAL_MS:    60000,   // resynchro périodique (dérive quartz négligeable)
        CLOCK_SYNC_TIMEOUT_MS:     4000,    // timeout d'un échantillon time_sync
        // Avance (lead) entre l'instruction prof et l'apparition de la question : c'est
        // la fenêtre pendant laquelle TOUS les postes doivent avoir pollé pour apprendre
        // `revealAt` avant qu'il n'arrive → révélation simultanée. Doit être >= intervalle
        // de poll de la phase concernée + marge réseau.
        // Lead ALLONGÉ (le polling est plus lent maintenant) : il doit rester >= l'intervalle
        // de poll de la phase + marge réseau, pour que TOUS les postes apprennent revealAt
        // AVANT qu'il n'arrive et s'alignent. 3,5 s > POLL_INTERVAL_QUESTION (3 s).
        REVEAL_LEAD_MS:            3500,    // questions Q1+
        FIRST_REVEAL_LEAD_MS:      4500,    // Q0 depuis le lobby (poll lobby 3 s + marge)
        // Délai d'avance AUTO entre la complétion d'une question et l'instruction de la
        // suivante. L'apparition réelle = ce délai + REVEAL_LEAD_MS (≈ 6 s, lecture du Top 3).
        AUTO_NEXT_DELAY_MS:        2500,
        // Fenêtre minimale (ms) pendant laquelle un élève peut répondre, même si la
        // question est arrivée tard (timer serveur déjà ~écoulé). Évite un « Temps écoulé »
        // instantané ; le scoring local + GRACE serveur valident la réponse.
        MIN_ANSWER_WINDOW_MS:     3000,
        // Anti-rafale du signalement de changement d'onglet : 1 beacon max par cette durée.
        TAB_SWITCH_DEBOUNCE_MS:   3000,
        // Fenêtre de transition RALENTIE (1,6 s vs 800 ms) : c'est la rafale SYNCHRONISÉE
        // (tous les postes détectent un changement en même temps) qui créait le pic à
        // ~40 req/s → ban de l'IP de classe. La sync v2 rend ce fast-poll inutile pour
        // l'AFFICHAGE (calé sur l'horloge) ; il ne sert plus qu'à détecter résultats/avance.
        POLL_INTERVAL_TRANSITION: 2200,   // ms — fenêtre « rapide » (détection, pas affichage) ; < REVEAL_LEAD_MS pour capter revealAt à temps
        POLL_TRANSITION_WINDOW_MS: 1500,  // ms — durée RACCOURCIE de la fenêtre rapide après un changement (moins de polls dans la rafale synchronisée)
        // Fast-poll de FIN de question DÉSACTIVÉ (0) : avec la sync v2, la fin de question
        // est auto-cadencée par l'horloge (pas besoin de l'« attraper » par un poll rapide) ;
        // ce burst de fin était une 2ᵉ rafale synchronisée coûteuse. Les résultats s'affichent
        // au poll suivant (cadence question), sans impact sur l'alignement ni les scores.
        POLL_PRE_TRANSITION_SECONDS: 0,   // s  — 0 = désactivé (cf. ci-dessus)
        // Jitter ÉLARGI (±30 %) : étale les rafales synchronisées → pic instantané par IP
        // bien plus bas (le chiffre qui fait bannir), à débit moyen quasi égal.
        POLL_JITTER_RATIO:        0.35,   // ±35 % aléatoire pour désynchroniser les clients (casse les rafales)
        // Cadence de mise à jour de la PROJECTION (poll get_control_state poussé par la
        // fenêtre pilote). 3 s suffit : les actions prof sont poussées instantanément via
        // pushInstantSync, et la projection révèle la question via son countdown aligné.
        PROJECTION_POLL_INTERVAL_MS: 3000,
        POLL_BOOST_MS:            1500,   // boost DOUX après détection/retour d'onglet (1500 vs 600 : sync v2 connaît déjà revealAt à l'avance → pas besoin d'un poll quasi-immédiat qui gonflait le pic synchronisé par IP)
        REQUEST_TIMEOUT_MS:       10000,  // timeout par requête (10 s)
        // 1 poll sur N est un get_state normal (rafraîchit lastPing côté serveur),
        // les autres sont des get_state_readonly (lecture pure sans flock, beaucoup
        // moins coûteux sous charge OVH). Porté de 6 à 10 : moins de polls tentent le
        // verrou exclusif → moins de contention disque/process sur OVH (cause des 500
        // en rafale). À 2 s/poll, N=10 → 1 ping/20 s, toujours < ACTIVE_PLAYER_THRESHOLD
        // (60 s). Et même un get_state contention ne bloque plus (fallback lecture seule).
        POLL_READONLY_RATIO:      10,
        // === Circuit breaker (anti-ban hébergeur) ===
        // Si N erreurs (4xx/5xx/timeout) dans WINDOW_MS, on met le polling en pause.
        // Pauses successives croissantes ; respect strict de l'en-tête Retry-After.
        // UI : « 🔌 Connexion lente, reprise dans XX s » — JAMAIS « Déconnecté ».
        // Pauses RACCOURCIES : le wifi du collège a des micro-coupures fréquentes ;
        // une première pause de 60 s faisait rater une question entière pour un simple
        // blip. 8 s permet un rattrapage quasi immédiat (règle « recover ASAP »), tout
        // en restant trivial pour l'hébergeur (25 élèves × 7,5 req/min = ~190 req/min
        // même en pleine tempête réseau). On n'escalade qu'en cas d'erreurs persistantes.
        CIRCUIT_BREAKER_THRESHOLD:  3,
        CIRCUIT_BREAKER_WINDOW_MS:  30000,
        CIRCUIT_BREAKER_PAUSES:     [8000, 20000, 45000],
        CIRCUIT_BREAKER_MAX_RETRY_AFTER_MS: 600000, // cap protectif contre Retry-After abusif
        // === Cadences de polling côté pilote (prof) ===
        CONTROL_POLL_INTERVAL_QUESTION: 2000,
        CONTROL_POLL_INTERVAL_IDLE:     4000
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
