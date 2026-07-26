// ============================================
// MODULE: SESSION MANAGER
// Description: Gestion des sessions de jeu en temps réel
// ============================================

(function() {
    'use strict';

    // État de la session actuelle
    const SESSION_STATE = {
        sessionId: null,
        playCode: null,
        quizData: null,
        schoolName: '',
        playerNickname: '',
        playerAnimal: '',
        isHost: false,
        gameState: 'waiting', // waiting, playing, finished
        currentQuestion: -1,
        score: 0,
        answers: [],
        wasKicked: false,  // Flag pour empêcher reconnexion après kicked
        isPaused: false,  // État de pause
        lastResultsHash: null,  // Hash des derniers résultats pour éviter doublons
        lastDisplayedResultsQuestion: null,  // Index de la dernière question dont les résultats ont été affichés
        pendingAnswers: [],  // Réponses en attente de renvoi après déconnexion
        clientEvents: []  // Buffer d'événements diagnostiques (envoyés au beforeunload)
    };

    // ========================================
    // CLIENT LOGGING (diagnostic post-mortem)
    // ========================================
    // On accumule des événements dans un buffer en RAM. Le buffer est envoyé
    // en UNE SEULE requête à la fin de la session (beforeunload via sendBeacon,
    // ou explicitement). Aucune requête HTTP supplémentaire pendant la partie
    // → pas de risque de ban de l'hébergeur. Capped à 500 events max en RAM.
    const MAX_CLIENT_EVENTS = 500;

    /**
     * Enregistre un événement diagnostique côté client. Pas d'envoi réseau —
     * juste accumulation. Vidé au beforeunload.
     * @param {string} type — court (cb_open, cb_close, pending_stored, etc.)
     * @param {object|string} [data] — détail libre (objet ou string)
     */
    function recordClientEvent(type, data) {
        try {
            if (SESSION_STATE.clientEvents.length >= MAX_CLIENT_EVENTS) {
                // Drop les plus vieux pour garder les plus récents
                SESSION_STATE.clientEvents.splice(0, 50);
            }
            const ev = {
                t: Date.now(),
                type: String(type).substring(0, 40),
                data: data ?? ''
            };
            // Ajouter automatiquement le visibility state pour contexte
            try { ev.vis = document.visibilityState; } catch (e) {}
            SESSION_STATE.clientEvents.push(ev);
        } catch (e) {}
    }
    window.recordClientEvent = recordClientEvent;

    /**
     * Envoie le buffer d'événements au serveur. Utilise sendBeacon en priorité
     * (fiable même au beforeunload), fallback fetch keepalive sinon.
     */
    function flushClientEvents(reason) {
        try {
            if (!SESSION_STATE.playCode || !SESSION_STATE.playerNickname) return;
            if (SESSION_STATE.clientEvents.length === 0) return;
            // Snapshot puis on vide pour éviter doubles envois
            const events = SESSION_STATE.clientEvents.slice();
            SESSION_STATE.clientEvents = [];

            // Marquer la raison d'envoi pour analyse a posteriori
            events.push({ t: Date.now(), type: 'flush', data: { reason: reason || 'manual', n: events.length } });

            const body = new FormData();
            body.append('action', 'client_log');
            body.append('playCode', SESSION_STATE.playCode);
            body.append('nickname', SESSION_STATE.playerNickname);
            body.append('events', JSON.stringify(events));

            if (navigator.sendBeacon) {
                navigator.sendBeacon('php/game.php', body);
            } else {
                // Fallback : fetch keepalive (fonctionne au beforeunload sur browsers récents)
                fetch('php/game.php', { method: 'POST', body, keepalive: true }).catch(() => {});
            }
        } catch (e) {}
    }
    window.flushClientEvents = flushClientEvents;

    // Liste des collèges (exemples)
    const SCHOOLS = [
        'Collège Jean Moulin',
        'Collège Victor Hugo',
        'Collège Marie Curie',
        'Collège Jules Verne',
        'Collège Jean de La Fontaine',
        'Collège Molière',
        'Collège Voltaire',
        'Collège Rousseau',
        'Collège Albert Camus',
        'Collège Simone de Beauvoir',
        'Collège George Sand',
        'Collège Jacques Prévert',
        'Collège Paul Éluard',
        'Collège Arthur Rimbaud',
        'Collège Charles Baudelaire',
        'Collège Émile Zola',
        'Collège Honoré de Balzac',
        'Collège Gustave Flaubert',
        'Collège Stendhal',
        'Collège Alexandre Dumas',
        'Autre (saisir le nom)'
    ];

    /**
     * Initialiser une session élève
     */
    function initStudentSession(playCode, quizData) {
        SESSION_STATE.playCode = playCode;
        SESSION_STATE.quizData = quizData;
        SESSION_STATE.sessionId = playCode;
        SESSION_STATE.isHost = false;
        SESSION_STATE.gameState = 'waiting';
        SESSION_STATE.currentQuestion = -1;  // -1 = aucune question encore affichée
        SESSION_STATE.displayedQuestion = -1; // index de la question RÉELLEMENT à l'écran (auto-réparation)
        SESSION_STATE.score = 0;
        SESSION_STATE.answers = [];
        SESSION_STATE.clientEvents = [];
        SESSION_STATE.hasEnteredGame = false;
        recordClientEvent('session_init', {
            ua: navigator.userAgent.substring(0, 100),
            screen: screen.width + 'x' + screen.height,
            online: navigator.onLine
        });

        // Récupérer les réponses en attente depuis localStorage
        recoverPendingAnswersFromStorage(playCode);

        // SYNCHRO v2 : démarrer la synchronisation d'horloge sur le serveur (handshake +
        // resynchro périodique). Indispensable pour la révélation alignée et le timer
        // visuel justes même si l'horloge de l'appareil est décalée.
        if (window.QwestClock) window.QwestClock.start();
    }

    // ========================================
    // RECONNEXION AUTO (anti-éjection sur reload / retour / pull-to-refresh)
    // ========================================
    // L'état de session vit en mémoire JS : un simple rechargement de page le perdait
    // et renvoyait l'élève à l'accueil (alors que le serveur le garde, juste marqué
    // "déconnecté"). On persiste donc {playCode, nickname} en sessionStorage (durée de
    // vie = l'onglet : un reload restaure, une fermeture volontaire efface) pour pouvoir
    // rejoindre automatiquement la partie en cours au prochain chargement.
    const ACTIVE_SESSION_KEY = 'qwest_active_session';

    function saveActiveSession() {
        try {
            if (!SESSION_STATE.playCode || !SESSION_STATE.playerNickname) return;
            sessionStorage.setItem(ACTIVE_SESSION_KEY, JSON.stringify({
                playCode: SESSION_STATE.playCode,
                nickname: SESSION_STATE.playerNickname,
                totalQuestions: (SESSION_STATE.quizData && SESSION_STATE.quizData.totalQuestions) || 0,
                ts: Date.now()
            }));
        } catch (e) { /* sessionStorage indisponible : pas de reco auto, tant pis */ }
    }

    function clearActiveSession() {
        try { sessionStorage.removeItem(ACTIVE_SESSION_KEY); } catch (e) {}
    }

    /**
     * Récupération après un "kicked" (joueur introuvable). Ce statut est souvent
     * TRANSITOIRE (lecture concurrente du fichier de session pendant un pic). On tente
     * une ré-adhésion silencieuse (même pseudo + deviceId) : joinGame reconnecte le
     * joueur (leave ne le supprime pas) ou le ré-ajoute → l'élève reprend EN PLACE,
     * sans freeze ni éjection vers l'accueil. On ne renvoie à l'accueil QUE si le serveur
     * confirme que la partie n'existe plus (sessionGone). Mono-vol (anti-spam).
     */
    async function attemptKickedRecovery() {
        if (kickedRecoveryInFlight) return;
        if (!SESSION_STATE.playCode || !SESSION_STATE.playerNickname) return;
        kickedRecoveryInFlight = true;
        try {
            const body = new URLSearchParams({
                action: 'join',
                playCode: SESSION_STATE.playCode,
                nickname: SESSION_STATE.playerNickname
            });
            if (SESSION_STATE.deviceId) body.set('deviceId', SESSION_STATE.deviceId);
            const resp = await fetch('php/game.php', {
                method: 'POST',
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                body: body
            });
            const result = await resp.json();
            if (result && result.success) {
                console.log('🔄 ÉLÈVE: ré-adhésion réussie après kicked');
            } else if (result && result.sessionGone) {
                // Partie réellement terminée/supprimée → accueil propre (cas rare).
                console.warn('🔌 ÉLÈVE: partie introuvable → accueil');
                clearActiveSession();
                pollingActive = false;
                if (pollingTimer) { clearTimeout(pollingTimer); pollingTimer = null; }
                if (window.showPage) window.showPage('home-page');
            } else {
                // deviceBusy ou autre : on n'insiste pas (ni home, ni spam) — un autre
                // onglet de ce poste détient peut-être le pseudo.
                console.warn('🔌 ÉLÈVE: ré-adhésion non aboutie:', result && result.message);
            }
        } catch (e) {
            console.warn('ré-adhésion kicked: erreur réseau', e);
        } finally {
            kickedRecoveryInFlight = false;
        }
    }

    /**
     * Tente de rejoindre automatiquement une partie en cours (appelée au chargement de
     * la page). Retourne true si la reconnexion a réussi (l'élève est replacé dans la
     * partie), false sinon (→ l'appelant affiche l'accueil normalement).
     */
    async function tryRejoinActiveSession() {
        let saved = null;
        try { saved = JSON.parse(sessionStorage.getItem(ACTIVE_SESSION_KEY) || 'null'); } catch (e) {}
        if (!saved || !saved.playCode || !saved.nickname) return false;
        // Garde-fou : ne pas ressusciter une session trop vieille (onglet laissé ouvert).
        if (saved.ts && (Date.now() - saved.ts) > 3 * 3600 * 1000) { clearActiveSession(); return false; }

        // Vérifier que la partie existe encore ET que l'élève y est toujours.
        let data = null;
        try {
            const resp = await fetch('php/game.php?action=get_state&playCode=' +
                encodeURIComponent(saved.playCode) + '&nickname=' + encodeURIComponent(saved.nickname));
            data = await resp.json();
        } catch (e) {
            return false; // réseau KO au chargement : on laisse l'élève re-saisir le code
        }
        if (!data || !data.success || data.kicked || data.state === 'finished') {
            clearActiveSession();
            return false;
        }

        // OK : on replace l'élève dans la partie et on relance le polling. Le 1er poll
        // affichera la salle d'attente (waiting) ou la question courante (playing).
        initStudentSession(saved.playCode, { name: '', totalQuestions: saved.totalQuestions || 0 });
        SESSION_STATE.playerNickname = saved.nickname;
        SESSION_STATE.playerAnimal = saved.nickname;
        if (window.APP_STATE) window.APP_STATE.currentPlayCode = saved.playCode;
        if (window.showPage) window.showPage('game-page');
        if (window.showWaitingRoom) window.showWaitingRoom();
        startPolling();
        console.log('🔄 ÉLÈVE: reconnexion automatique à la partie', saved.playCode);
        return true;
    }

    /**
     * Récupérer les réponses sauvegardées en localStorage
     */
    function recoverPendingAnswersFromStorage(playCode) {
        try {
            const keys = Object.keys(localStorage).filter(k => k.startsWith(`qwest_answer_${playCode}_`));
            
            if (keys.length > 0) {
                console.log('🔄 ÉLÈVE: Récupération de', keys.length, 'réponse(s) depuis localStorage');
                
                keys.forEach(key => {
                    try {
                        const data = JSON.parse(localStorage.getItem(key));
                        if (data && data.questionIndex !== undefined) {
                            // Vérifier si pas déjà dans pendingAnswers
                            const exists = SESSION_STATE.pendingAnswers.some(p => p.questionIndex === data.questionIndex);
                            if (!exists) {
                                SESSION_STATE.pendingAnswers.push({
                                    questionIndex: data.questionIndex,
                                    answer: data.answer,
                                    timeSpent: data.timeSpent,
                                    timestamp: data.timestamp
                                });
                                console.log('💾 ÉLÈVE: Réponse récupérée pour question', data.questionIndex);
                            }
                        }
                    } catch (e) {
                        console.warn('⚠️ Erreur lecture localStorage:', key);
                    }
                });
                
                // Programmer un retry si des réponses ont été récupérées
                if (SESSION_STATE.pendingAnswers.length > 0) {
                    setTimeout(() => scheduleBackgroundRetry(), 2000);
                }
            }
        } catch (e) {
            console.warn('⚠️ localStorage non disponible pour récupération');
        }
    }

    /**
     * Définir les informations du joueur
     */
    function setPlayerInfo(schoolName, animal) {
        SESSION_STATE.schoolName = '';
        SESSION_STATE.playerAnimal = animal;
        SESSION_STATE.playerNickname = animal;
    }

    /**
     * Rejoindre une session
     */
    /**
     * Bandeau de notification non bloquant (remplace alert() pendant le jeu).
     */
    function showStudentNotice(message, isError) {
        try {
            let el = document.getElementById('student-notice');
            if (!el) {
                el = document.createElement('div');
                el.id = 'student-notice';
                el.style.cssText = 'position:fixed;top:16px;left:50%;transform:translateX(-50%);max-width:92%;padding:12px 18px;border-radius:10px;box-shadow:0 4px 16px rgba(0,0,0,0.2);z-index:10001;font-size:15px;text-align:center;font-weight:600;';
                document.body.appendChild(el);
            }
            el.style.background = isError ? '#fff3e0' : '#e8f5e9';
            el.style.color = isError ? '#b71c1c' : '#2e7d32';
            el.style.borderLeft = '4px solid ' + (isError ? '#ff9800' : '#2e7d32');
            el.textContent = (isError ? '⚠️ ' : '✅ ') + message;
            el.style.display = 'block';
            if (el._t) clearTimeout(el._t);
            el._t = setTimeout(function() { if (el) el.style.display = 'none'; }, 5000);
        } catch (e) { /* fallback silencieux */ }
    }

    async function joinSession() {
        // deviceId persistant (anti double-connexion). Même clé que la sélection d'avatar.
        // Mémorisé sur SESSION_STATE pour la ré-adhésion auto après un "kicked".
        try {
            const did = localStorage.getItem('qwest_device_id');
            if (did) SESSION_STATE.deviceId = did;
        } catch (e) {}

        console.log('🔵 Tentative de rejoindre la session:', {
            playCode: SESSION_STATE.playCode,
            nickname: SESSION_STATE.playerNickname
        });

        // RETRY automatique : sur l'hébergement mutualisé (cluster), une partie tout
        // juste créée peut être invisible ~1 s depuis un autre nœud (sessionGone à
        // tort), et une rafale de joins simultanés peut occuper le verrou (retryable).
        // On retente donc avant de conclure — SAUF refus définitifs (appareil déjà
        // connecté, pseudo pris par un autre appareil).
        const delays = [0, 800, 1500, 2500];
        let lastResult = null;
        for (let attempt = 0; attempt < delays.length; attempt++) {
            if (delays[attempt]) await new Promise(r => setTimeout(r, delays[attempt]));
            try {
                const body = new URLSearchParams({
                    action: 'join',
                    playCode: SESSION_STATE.playCode,
                    nickname: SESSION_STATE.playerNickname
                });
                if (SESSION_STATE.deviceId) body.set('deviceId', SESSION_STATE.deviceId);

                const response = await fetch('php/game.php', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                    body: body
                });

                const result = await response.json();
                console.log('🔵 Réponse joinSession (tentative ' + (attempt + 1) + '):', result);

                if (result.success) {
                    // Persister la session pour la reconnexion auto (anti-éjection au reload).
                    saveActiveSession();
                    connectToEventStream();
                    return true;
                }
                lastResult = result;
                if (result.deviceBusy || result.nicknameTaken) break; // refus définitifs
                console.warn('⚠️ joinSession échec (tentative ' + (attempt + 1) + '):', result.message);
            } catch (error) {
                lastResult = null;
                console.error('❌ Erreur réseau joinSession (tentative ' + (attempt + 1) + '):', error);
            }
        }
        console.error('❌ Échec joinSession après retries');
        showStudentNotice((lastResult && lastResult.message) || 'Erreur de connexion au serveur — réessaie', true);
        return false;
    }

    /**
     * Connecter au système de polling (remplace le SSE)
     */
    function connectToEventStream() {
        console.log('🔵 Démarrage du polling élève');
        startPolling();
    }

    // Note: Le ping est maintenant géré par le polling via get_state

    /**
     * Gérer les événements de jeu (fonction gardée pour compatibilité mais plus utilisée avec polling)
     */
    function handleGameEvent(data) {
        SESSION_STATE.lastPing = Date.now();

        switch(data.type) {
            case 'players_update':
                updatePlayersList(data.players);
                break;
            case 'game_start':
                startGame(data);
                break;
            case 'show_question':
                showQuestion(data);
                break;
            case 'show_results':
                showResults(data);
                break;
            case 'game_end':
                endGame(data);
                break;
        }
    }

    /**
     * Envoyer un ping au serveur
     */
    async function sendPing() {
        if (!SESSION_STATE.playCode || !SESSION_STATE.playerNickname) return;

        try {
            await fetch('php/game.php', {
                method: 'POST',
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                body: new URLSearchParams({
                    action: 'ping',
                    playCode: SESSION_STATE.playCode,
                    nickname: SESSION_STATE.playerNickname
                })
            });
        } catch (error) {
            console.error('Erreur ping:', error);
        }
    }

    /**
     * Envoyer une réponse
     */
    async function submitAnswer(answer, timeSpent) {
        console.log('📤 ÉLÈVE: Envoi réponse', { answer, timeSpent, questionIndex: SESSION_STATE.currentQuestion });

        // Sauvegarder immédiatement en localStorage comme backup
        const backupKey = `qwest_answer_${SESSION_STATE.playCode}_${SESSION_STATE.currentQuestion}`;
        try {
            localStorage.setItem(backupKey, JSON.stringify({
                answer,
                timeSpent,
                questionIndex: SESSION_STATE.currentQuestion,
                nickname: SESSION_STATE.playerNickname,
                timestamp: Date.now()
            }));
            console.log('💾 ÉLÈVE: Réponse sauvegardée en localStorage');
        } catch (e) {
            console.warn('⚠️ localStorage non disponible');
        }

        // Si circuit breaker en pause : on ne tente RIEN tout de suite,
        // on bufferise et on laisse le retry de fond s'occuper de l'envoi
        // dès que la pause expire. Évite d'amplifier le ban.
        if (isCircuitPaused()) {
            console.log('🔌 ÉLÈVE: CB ouvert, réponse mise en attente');
            storePendingAnswer(answer, timeSpent, SESSION_STATE.currentQuestion);
            scheduleBackgroundRetry();
            return false;
        }

        // Essayer d'envoyer avec plusieurs tentatives immédiates
        const maxRetries = 3;

        for (let attempt = 1; attempt <= maxRetries; attempt++) {
            if (isCircuitPaused()) {
                console.log('🔌 ÉLÈVE: CB ouvert pendant retry, abandon des tentatives immédiates');
                break;
            }
            try {
                console.log(`📤 ÉLÈVE: Tentative ${attempt}/${maxRetries}...`);

                const response = await fetch('php/game.php', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                    body: new URLSearchParams({
                        action: 'answer',
                        playCode: SESSION_STATE.playCode,
                        nickname: SESSION_STATE.playerNickname,
                        questionIndex: SESSION_STATE.currentQuestion,
                        answer: JSON.stringify(answer),
                        timeSpent: timeSpent
                    })
                });

                if (!response.ok) {
                    const retryAfterMs = parseRetryAfterMs(response);
                    console.warn('⚠️ ÉLÈVE: HTTP', response.status, 'sur answer');
                    recordCircuitError(retryAfterMs, httpErrCtx(response));
                    break; // on arrête les retries immédiats, le retry de fond reprendra après la pause
                }

                const result = await response.json();

                if (result.success) {
                    if (result.lateAccepted) {
                        console.log('✅ ÉLÈVE: Réponse acceptée rétroactivement (tentative ' + attempt + ')');
                    } else {
                        console.log('✅ ÉLÈVE: Réponse envoyée avec succès (tentative ' + attempt + ')');
                    }
                    // Le HTTP 200 ne suffit PAS : sur l'hébergement mutualisé, une réponse
                    // acceptée peut ensuite être engloutie par une écriture concurrente de
                    // la session. On la garde « en attente de confirmation » jusqu'à ce
                    // qu'un poll la renvoie dans myAnswered (le backup localStorage est
                    // conservé jusque-là). Re-émission automatique sinon.
                    registerAwaitingConfirm(SESSION_STATE.currentQuestion, answer, timeSpent);
                    return true;
                }

                // Rejet définitif côté serveur (vraiment hors délai ou question changée) :
                // inutile de retenter, on nettoie le backup et on sort proprement.
                if (result.tooLate) {
                    console.warn('⛔ ÉLÈVE: Réponse rejetée définitivement par le serveur', result.reason);
                    try { localStorage.removeItem(backupKey); } catch (e) {}
                    return false;
                }

                console.warn(`⚠️ ÉLÈVE: Échec envoi réponse (serveur) - tentative ${attempt}`);

            } catch (error) {
                console.error(`❌ ÉLÈVE: Erreur envoi réponse (réseau) - tentative ${attempt}:`, error);
                recordCircuitError(0, netErrCtx(error));
                if (isCircuitPaused()) break;
            }

            // Attendre avant de réessayer (sauf dernière tentative)
            if (attempt < maxRetries) {
                await new Promise(resolve => setTimeout(resolve, 500 * attempt)); // 500ms, 1s, 1.5s
            }
        }

        // Toutes les tentatives ont échoué ou CB ouvert : on bufferise et on laisse le fond gérer
        console.warn('⚠️ ÉLÈVE: Tentatives immédiates épuisées, bascule en buffer');
        storePendingAnswer(answer, timeSpent, SESSION_STATE.currentQuestion);
        scheduleBackgroundRetry();

        return false;
    }
    
    /**
     * Programmer des retries en arrière-plan, avec backoff espacé.
     *
     * Auparavant : interval fixe de 3 s → à 20 élèves × pendingAnswers × 3 s = rafale
     * permanente vers le serveur tant que la pendingAnswer n'est pas envoyée.
     *
     * Maintenant : backoff 2 → 8 → 20 → 60 s (cap). Chaque tentative qui n'envoie
     * rien (CB ouvert, réseau coupé) incrémente le palier ; chaque envoi réussi
     * remet à zéro. Et le retry respecte le circuit breaker (cf. retryPendingAnswers).
     */
    const PENDING_RETRY_DELAYS = [2000, 8000, 20000, 60000];
    let backgroundRetryTimer = null;
    let backgroundRetryLevel = 0;

    // ========================================
    // CONFIRMATION DES RÉPONSES (anti lost-update serveur)
    // ========================================
    // Une réponse acceptée en HTTP peut être engloutie côté hébergement mutualisé par
    // une écriture concurrente de la session (copie périmée réécrite par-dessus). Le
    // serveur renvoie donc dans chaque get_state la liste myAnswered des questions où
    // MA réponse est réellement enregistrée. Tant qu'une réponse envoyée n'y apparaît
    // pas, on la considère « non confirmée » et on la ré-émet (answer_bulk, dédoublonné
    // côté serveur). Vu du score : aucune différence (scores dérivés des réponses).
    let awaitingConfirm = {}; // questionIndex -> { answer, timeSpent, sentAt, resends }
    const CONFIRM_RESEND_AFTER_MS = 3000;
    const CONFIRM_MAX_RESENDS = 8;

    function registerAwaitingConfirm(questionIndex, answer, timeSpent) {
        const prev = awaitingConfirm[questionIndex];
        awaitingConfirm[questionIndex] = {
            answer: answer,
            timeSpent: timeSpent,
            sentAt: Date.now(),
            resends: prev ? prev.resends : 0
        };
    }

    function processAnswerConfirmations(myAnswered) {
        if (!Array.isArray(myAnswered)) return;
        const confirmedSet = new Set(myAnswered.map(Number));
        for (const key of Object.keys(awaitingConfirm)) {
            const q = Number(key);
            const entry = awaitingConfirm[key];
            if (confirmedSet.has(q)) {
                // Confirmé : la réponse est bien dans la session serveur.
                delete awaitingConfirm[key];
                try { localStorage.removeItem(`qwest_answer_${SESSION_STATE.playCode}_${q}`); } catch (e) {}
                continue;
            }
            if (Date.now() - entry.sentAt < CONFIRM_RESEND_AFTER_MS) continue;
            if (entry.resends >= CONFIRM_MAX_RESENDS) continue;
            entry.resends++;
            entry.sentAt = Date.now();
            console.warn('🔁 ÉLÈVE: réponse Q' + q + ' non confirmée par le serveur — ré-émission (' +
                         entry.resends + '/' + CONFIRM_MAX_RESENDS + ')');
            recordClientEvent('answer_reemitted', { q: q, n: entry.resends });
            storePendingAnswer(entry.answer, entry.timeSpent, q);
            retryPendingAnswers(); // mono-vol + intervalle min déjà garantis
        }
    }

    function scheduleBackgroundRetry() {
        if (backgroundRetryTimer) return; // Déjà programmé
        if (SESSION_STATE.pendingAnswers.length === 0) {
            backgroundRetryLevel = 0;
            return;
        }
        // Si CB ouvert, on attend au moins la fin de la pause avant la première tentative
        const baseDelay = PENDING_RETRY_DELAYS[Math.min(backgroundRetryLevel, PENDING_RETRY_DELAYS.length - 1)];
        const pauseDelay = timeUntilCircuitReopens();
        const delay = Math.max(baseDelay, pauseDelay + 200);
        console.log('🔄 ÉLÈVE: Prochain retry pending dans', Math.round(delay / 1000), 's (palier', backgroundRetryLevel, ')');

        backgroundRetryTimer = setTimeout(async () => {
            backgroundRetryTimer = null;
            if (SESSION_STATE.pendingAnswers.length === 0) {
                console.log('✅ ÉLÈVE: Plus de réponses en attente, arrêt des retries');
                backgroundRetryLevel = 0;
                return;
            }
            const beforeCount = SESSION_STATE.pendingAnswers.length;
            await retryPendingAnswers();
            const afterCount = SESSION_STATE.pendingAnswers.length;

            if (afterCount === 0) {
                console.log('✅ ÉLÈVE: Toutes les pendingAnswers envoyées');
                backgroundRetryLevel = 0;
                return;
            }
            // Si le retry n'a rien fait avancer, on augmente le palier ;
            // sinon on remet à zéro pour rester réactif.
            if (afterCount >= beforeCount) {
                backgroundRetryLevel = Math.min(backgroundRetryLevel + 1, PENDING_RETRY_DELAYS.length - 1);
            } else {
                backgroundRetryLevel = 0;
            }
            scheduleBackgroundRetry();
        }, delay);
    }
    
    /**
     * Stocker une réponse en attente de renvoi
     */
    function storePendingAnswer(answer, timeSpent, questionIndex) {
        const pending = {
            questionIndex: questionIndex,
            answer: answer,
            timeSpent: timeSpent,
            timestamp: Date.now()
        };

        // Éviter les doublons
        const exists = SESSION_STATE.pendingAnswers.some(p => p.questionIndex === questionIndex);
        if (!exists) {
            SESSION_STATE.pendingAnswers.push(pending);
            console.log('💾 ÉLÈVE: Réponse stockée pour renvoi ultérieur', pending);
            recordClientEvent('pending_stored', { q: questionIndex, t: timeSpent });

            // Afficher un message à l'élève
            showConnectionWarning();
        }
    }
    
    /**
     * Renvoyer les réponses en attente après reconnexion
     */
    async function retryPendingAnswers() {
        if (SESSION_STATE.pendingAnswers.length === 0) {
            return;
        }
        if (isCircuitPaused()) {
            console.log('🔌 ÉLÈVE: retryPendingAnswers reporté (CB ouvert)');
            return;
        }
        // Mono-vol : un seul answer_bulk en cours à la fois (anti-tempête).
        if (answerRetryInFlight) {
            return;
        }
        // Intervalle minimal entre deux envois (le poll + les timers backoff appellent
        // tous cette fonction ; sans ce frein on POSTait answer_bulk en rafale).
        if ((Date.now() - lastAnswerRetryTs) < MIN_ANSWER_RETRY_INTERVAL_MS) {
            return;
        }
        answerRetryInFlight = true;
        lastAnswerRetryTs = Date.now();

        // Coalescence : on envoie TOUTES les réponses en attente dans une SEULE
        // requête (action=answer_bulk). Au retour d'une coupure Wifi sur N
        // questions ratées, cela divise le volume HTTP par N.
        const toRetry = [...SESSION_STATE.pendingAnswers];
        SESSION_STATE.pendingAnswers = [];

        const payload = toRetry.map(p => ({
            questionIndex: p.questionIndex,
            // CRITIQUE : answer DOIT être une CHAÎNE JSON, comme le flux simple
            // (action=answer envoie JSON.stringify(answer)). Avant, on envoyait l'OBJET
            // brut → côté serveur il était stocké en tableau PHP, et json_decode(tableau)
            // levait une TypeError FATALE (PHP 8) à chaque get_state → 500 → classe figée.
            answer: (typeof p.answer === 'string') ? p.answer : JSON.stringify(p.answer),
            timeSpent: p.timeSpent
        }));
        console.log('🔄 ÉLÈVE: Renvoi BULK de', payload.length, 'réponse(s)');

        try {
            const response = await fetch('php/game.php', {
                method: 'POST',
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                body: new URLSearchParams({
                    action: 'answer_bulk',
                    playCode: SESSION_STATE.playCode,
                    nickname: SESSION_STATE.playerNickname,
                    answers: JSON.stringify(payload)
                })
            });

            if (!response.ok) {
                const retryAfterMs = parseRetryAfterMs(response);
                console.warn('⚠️ ÉLÈVE: HTTP', response.status, 'sur bulk');
                // Un 429 (throttle) → on respecte le Retry-After (pause CB légitime). Un
                // 500 (retryAfterMs=0) ne doit PAS ouvrir le breaker : sinon une rafale de
                // 500 answer_bulk figeait TOUT le polling. On re-met en file ; le backoff
                // (scheduleBackgroundRetry) + l'intervalle minimal espacent le prochain essai.
                if (retryAfterMs > 0) {
                    recordCircuitError(retryAfterMs, httpErrCtx(response));
                }
                SESSION_STATE.pendingAnswers = toRetry.concat(SESSION_STATE.pendingAnswers);
                return;
            }

            const data = await response.json();
            if (!data || !data.success || !Array.isArray(data.results)) {
                console.warn('⚠️ ÉLÈVE: réponse bulk inattendue', data);
                // Si on a un message d'erreur générique mais pas une erreur réseau → on remet
                SESSION_STATE.pendingAnswers = toRetry.concat(SESSION_STATE.pendingAnswers);
                return;
            }

            // Apparier par questionIndex
            const resultByQ = {};
            for (const r of data.results) {
                if (r && typeof r.questionIndex === 'number') {
                    resultByQ[r.questionIndex] = r;
                }
            }

            for (const pending of toRetry) {
                const r = resultByQ[pending.questionIndex];
                if (r && (r.success || r.tooLate)) {
                    if (r.success) {
                        console.log('✅ ÉLÈVE: bulk Q', pending.questionIndex,
                                    r.lateAccepted ? '(rétroactive)' : r.duplicate ? '(déjà)' : '(OK)');
                        if (r.duplicate) {
                            // « duplicate » = le serveur a LU la réponse dans la session :
                            // confirmation directe — on peut tout nettoyer.
                            delete awaitingConfirm[pending.questionIndex];
                            try {
                                localStorage.removeItem(`qwest_answer_${SESSION_STATE.playCode}_${pending.questionIndex}`);
                            } catch (e) {}
                        } else {
                            // Enregistrée à l'instant : à confirmer par un prochain poll
                            // (myAnswered) — le backup localStorage est conservé jusque-là.
                            registerAwaitingConfirm(pending.questionIndex, pending.answer, pending.timeSpent);
                        }
                    } else {
                        // Rejet définitif (vraiment hors délai) : on nettoie.
                        console.warn('⛔ ÉLÈVE: bulk Q', pending.questionIndex, 'rejetée:', r.reason);
                        delete awaitingConfirm[pending.questionIndex];
                        try {
                            localStorage.removeItem(`qwest_answer_${SESSION_STATE.playCode}_${pending.questionIndex}`);
                        } catch (e) {}
                    }
                } else {
                    // Pas de résultat → remettre en attente
                    console.warn('⚠️ ÉLÈVE: bulk Q', pending.questionIndex, 'sans résultat, remise en attente');
                    SESSION_STATE.pendingAnswers.push(pending);
                }
            }
        } catch (error) {
            console.error('❌ ÉLÈVE: Erreur bulk (réseau)', error);
            recordCircuitError(0, netErrCtx(error));
            SESSION_STATE.pendingAnswers = toRetry.concat(SESSION_STATE.pendingAnswers);
            return;
        } finally {
            answerRetryInFlight = false;
        }

        if (SESSION_STATE.pendingAnswers.length > 0) {
            console.warn('⚠️ ÉLÈVE:', SESSION_STATE.pendingAnswers.length, 'réponse(s) encore en attente');
        } else {
            console.log('✅ ÉLÈVE: Toutes les réponses en attente ont été envoyées');
            hideConnectionWarning();
            if (!isCircuitPaused()) {
                await forceSyncGameState();
            }
        }
    }
    
    /**
     * Forcer une synchronisation immédiate de l'état du jeu
     * Utilisé après reconnexion pour récupérer l'état manqué pendant la déconnexion
     */
    async function forceSyncGameState(opts) {
        opts = opts || {};
        const forceRedisplay = !!opts.forceRedisplay; // au retour de visibility hidden
        // Respecter le circuit breaker
        if (isCircuitPaused()) {
            console.log('🔌 ÉLÈVE: forceSyncGameState reporté (CB ouvert)');
            return;
        }
        try {
            // Variante LECTURE SEULE : ce sync est déclenché aux pires moments pour une
            // écriture concurrente (pushInstantSync du pilote juste APRÈS un next_question
            // pour la fenêtre teacher-play, retour de visibilité…). Une écriture de la
            // session ici (refresh lastPing) pouvait réécrire une copie périmée par-dessus
            // l'avance fraîchement sauvegardée (lost update mutualisé). Le rafraîchissement
            // de lastPing reste assuré par le poll normal (1 sur POLL_READONLY_RATIO) et
            // par chaque envoi de réponse.
            const reqSentAt = Date.now();
            const response = await fetch(`php/game.php?action=get_state_readonly&playCode=${SESSION_STATE.playCode}&nickname=${encodeURIComponent(SESSION_STATE.playerNickname)}`);
            const reqRecvAt = Date.now();
            if (!response.ok) {
                const retryAfterMs = parseRetryAfterMs(response);
                console.warn('⚠️ ÉLÈVE: forceSync HTTP', response.status);
                recordCircuitError(retryAfterMs, httpErrCtx(response));
                return;
            }
            const data = await response.json();
            if (data && typeof data.serverTimeMs === 'number' && window.QwestClock) {
                window.QwestClock.observe(data.serverTimeMs, reqSentAt, reqRecvAt);
            }

            if (!data.success) {
                console.warn('⚠️ ÉLÈVE: Échec sync état');
                return;
            }
            lastSyncTs = Date.now();

            // Même traitement de confirmation que le poll normal
            if (data.myAnswered !== undefined) {
                processAnswerConfirmations(data.myAnswered);
            }

            console.log('✅ ÉLÈVE: État du jeu synchronisé', {
                state: data.state,
                currentQuestion: data.currentQuestion,
                hasResults: !!data.results
            });
            
            // Si des résultats sont disponibles et qu'on ne les a pas affichés
            if (data.results) {
                const questionIndex = data.results.questionIndex;
                if (SESSION_STATE.lastDisplayedResultsQuestion !== questionIndex) {
                    console.log('📊 ÉLÈVE: Affichage des résultats manqués (question', questionIndex, ')');
                    SESSION_STATE.lastDisplayedResultsQuestion = questionIndex;
                    if (window.showResults) {
                        showResults(data.results);
                    }
                }
            }
            
            // Question à (ré)afficher. On passe par le MÊME chemin idempotent que le poll
            // (ensureQuestionDisplayed) pour ne PLUS se télescoper avec lui (c'était la
            // cause du blocage de Q0 sur mobile : forceSync affichait, puis le poll
            // ré-entrait en "première entrée" et écrasait par un countdown). Cas particulier
            // conservé : même question mais DOM perdu en arrière-plan → re-render forcé.
            if (data.state === 'playing' && data.question && data.currentQuestion >= 0) {
                SESSION_STATE.hasEnteredGame = true;
                if (SESSION_STATE.displayedQuestion !== data.currentQuestion) {
                    ensureQuestionDisplayed(data);
                    recordClientEvent('question_redisplayed', { q: data.currentQuestion, reason: 'reconcile' });
                } else if (forceRedisplay) {
                    const screenMissing = !document.querySelector('.question-screen, .answers-container, [class*="answer-feedback"], .results-screen, .countdown-screen, .final-screen');
                    if (screenMissing && window.showQuestion) {
                        console.log('📩 ÉLÈVE: re-render forcé (DOM perdu en arrière-plan), question', data.currentQuestion);
                        showQuestion(data.question);
                        recordClientEvent('question_redisplayed', { q: data.currentQuestion, reason: 'force_visibility' });
                    }
                }
            }

        } catch (error) {
            console.error('❌ ÉLÈVE: Erreur sync état:', error);
            recordCircuitError(0, netErrCtx(error));
        }
    }

    /**
     * Afficher un avertissement de connexion
     */
    function showConnectionWarning() {
        // Éviter les doublons
        if (document.getElementById('connection-warning')) return;
        
        const warning = document.createElement('div');
        warning.id = 'connection-warning';
        warning.style.cssText = `
            position: fixed;
            top: 20px;
            left: 50%;
            transform: translateX(-50%);
            background: #ff9800;
            color: white;
            padding: 15px 25px;
            border-radius: 8px;
            box-shadow: 0 4px 12px rgba(0,0,0,0.3);
            z-index: 10000;
            font-weight: 600;
            font-size: 16px;
            animation: slideDown 0.3s ease;
        `;
        warning.innerHTML = '⚠️ Connexion instable. Ta réponse sera envoyée automatiquement.';
        document.body.appendChild(warning);
    }
    
    /**
     * Masquer l'avertissement de connexion
     */
    function hideConnectionWarning() {
        const warning = document.getElementById('connection-warning');
        if (warning) {
            warning.remove();
        }
    }
    
    // ========================================
    // NOUVEAU : WATCHDOG ANTI-BLOCAGE
    // ========================================
    // Ce système vérifie si l'élève est bloqué sur "En attente des autres joueurs"
    // et demande activement au serveur de vérifier le timeout
    
    /**
     * Démarrer le watchdog quand l'élève a répondu
     * Le watchdog côté client est désormais désactivé : le polling adaptatif (get_state)
     * appelle déjà checkAndForceQuestionCompletion côté serveur à chaque requête, et le
     * serveur renvoie les résultats dès qu'ils sont disponibles. Garder un watchdog
     * supplémentaire doublait inutilement le trafic (20 élèves × 30 req/min = +600 req/min).
     * Les fonctions sont conservées en no-op pour ne pas casser les appels existants.
     */
    function startWatchdog(questionIndex, expectedEndTime) {
        // No-op intentionnel — le polling get_state suffit
    }

    function stopWatchdog() {
        if (watchdogTimer) {
            clearTimeout(watchdogTimer);
            watchdogTimer = null;
        }
        watchdogAttempts = 0;
    }
    
    /**
     * Vérifier si on est toujours bloqué et demander une resync
     */
    async function checkWatchdog(questionIndex) {
        // Vérifier qu'on est bien sur l'écran d'attente
        const feedbackScreen = document.querySelector('.answer-feedback');
        if (!feedbackScreen) {
            console.log('🐕 WATCHDOG: Plus sur l\'écran d\'attente, arrêt');
            stopWatchdog();
            return;
        }
        
        watchdogAttempts++;
        console.log(`🐕 WATCHDOG: Vérification #${watchdogAttempts} pour Q${questionIndex}`);
        
        try {
            // Appeler l'API pour forcer la vérification du timeout
            const response = await fetch(`php/game.php?action=check_question_timeout&playCode=${SESSION_STATE.playCode}&nickname=${encodeURIComponent(SESSION_STATE.playerNickname)}&questionIndex=${questionIndex}`);
            const data = await response.json();
            
            console.log('🐕 WATCHDOG: Réponse serveur', data);
            
            if (data.success && data.questionCompleted) {
                // La question est maintenant complétée, afficher les résultats
                console.log('🐕 WATCHDOG: Question complétée, affichage des résultats');
                stopWatchdog();
                
                if (data.results && window.displayQuestionResults) {
                    // Mettre à jour l'index de la dernière question affichée
                    SESSION_STATE.lastDisplayedResultsQuestion = data.results.questionIndex;
                    window.displayQuestionResults(data.results);
                }
            } else if (watchdogAttempts < WATCHDOG_MAX_ATTEMPTS) {
                // Réessayer silencieusement dans 2 secondes (plus rapide)
                console.log(`🐕 WATCHDOG: Pas encore complétée, nouvelle tentative dans 2s`);
                watchdogTimer = setTimeout(() => {
                    checkWatchdog(questionIndex);
                }, 2000);
            } else {
                // Après plusieurs tentatives, continuer à réessayer silencieusement
                console.log('🐕 WATCHDOG: Continuation des tentatives silencieuses');
                watchdogTimer = setTimeout(() => {
                    checkWatchdog(questionIndex);
                }, 3000);
            }
        } catch (error) {
            console.error('🐕 WATCHDOG: Erreur', error);
            
            // Réessayer silencieusement
            watchdogTimer = setTimeout(() => {
                checkWatchdog(questionIndex);
            }, 2000);
        }
    }
    
    /**
     * Demande manuelle de resync par l'élève : on déclenche simplement un poll immédiat
     * via forceSyncGameState (équivalent get_state, déjà disponible). Plus besoin
     * d'appeler check_question_timeout : le get_state retourne directement les résultats.
     */
    window.manualResyncRequest = async function() {
        console.log('🔄 ÉLÈVE: Demande manuelle de resync (poll forcé)');
        try {
            await forceSyncGameState();
        } catch (error) {
            console.error('Erreur resync manuelle:', error);
        }
    };

    /**
     * Quitter la session
     */
    function leaveSession() {
        // Départ volontaire : on efface la session persistée pour NE PAS reconnecter
        // automatiquement au prochain chargement.
        clearActiveSession();
        if (SESSION_STATE.eventSource) {
            SESSION_STATE.eventSource.close();
        }

        // Notifier le serveur
        if (SESSION_STATE.playCode && SESSION_STATE.playerNickname) {
            fetch('php/game.php', {
                method: 'POST',
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                body: new URLSearchParams({
                    action: 'leave',
                    playCode: SESSION_STATE.playCode,
                    nickname: SESSION_STATE.playerNickname
                })
            });
        }

        // Réinitialiser l'état
        SESSION_STATE.sessionId = null;
        SESSION_STATE.playCode = null;
        SESSION_STATE.eventSource = null;
    }

    /**
     * Obtenir la liste des collèges
     */
    function getSchools() {
        return SCHOOLS;
    }

    /**
     * Obtenir l'état actuel de la session
     */
    function getSessionState() {
        return { ...SESSION_STATE };
    }

    // ========================================
    // FONCTIONS APPELÉES PAR LES ÉVÉNEMENTS
    // ========================================
    // Ces fonctions seront implémentées dans game.js

    function updatePlayersList(players) {
        if (window.updateWaitingRoom) {
            window.updateWaitingRoom(players);
        }
    }

    function startGame(data, countdownMs) {
        if (window.handleGameStart) {
            window.handleGameStart(data, countdownMs);
        }
    }

    /**
     * Délai (ms) avant d'afficher la 1ʳᵉ question, ALIGNÉ sur l'horloge serveur.
     * Tous les clients visent le même instant absolu = questionStartTime +
     * FIRST_QUESTION_COUNTDOWN_MS (horloge serveur), quel que soit le moment où ils
     * ont pollé → décalage inter-postes < 1 s sur la 1ʳᵉ question.
     *
     * data.serverTime et data.question.startTime sont en SECONDES (horloge serveur) ;
     * leur DIFFÉRENCE est exacte indépendamment de l'horloge locale du client. Si
     * l'info manque, on retombe sur le countdown fixe (comportement historique).
     */
    /**
     * Délai (ms) pour révéler la question courante à l'instant absolu
     * questionStartTime + offsetMs (horloge SERVEUR — immunisé contre les horloges
     * décalées des postes élèves). 0 si l'échéance est déjà passée (détection
     * tardive → affichage immédiat). Utilisé pour Q1+ (offset = REVEAL_DELAY_MS).
     */
    /**
     * SYNCHRO v2 — délai (ms, en temps LOCAL) avant de révéler la question, pour viser
     * l'instant ABSOLU data.question.revealAt (ms horloge serveur). Conversion via
     * l'horloge synchronisée : delay = revealAt - QwestClock.now(). C'est CE délai qui
     * aligne TOUS les postes au même instant absolu, quel que soit le moment où chacun
     * a pollé. 0 si l'instant est déjà passé (détection tardive → affichage immédiat).
     *
     * Replis (par ordre de précision décroissante) :
     *   1. horloge synchronisée disponible        → revealAt - QwestClock.now()  [au ms près]
     *   2. revealAt + serverTime(s) du poll        → revealAt - serverTime*1000   [≈, à la latence réseau près]
     *   3. ancien schéma startTime/serverTime (s)  → (startTime - serverTime)*1000 [grossier]
     */
    function revealDelayMs(data) {
        try {
            const q = data && data.question;
            const revealAt = q && (typeof q.revealAt === 'number' ? q.revealAt : 0);
            if (revealAt > 0 && window.QwestClock && window.QwestClock.synced) {
                return Math.max(0, Math.round(revealAt - window.QwestClock.now()));
            }
            const sv = data && data.serverTime; // s serveur
            if (revealAt > 0 && typeof sv === 'number') {
                return Math.max(0, Math.round(revealAt - sv * 1000));
            }
            const st = q && q.startTime;
            if (typeof st === 'number' && typeof sv === 'number' && st > 0) {
                return Math.max(0, Math.round((st - sv) * 1000));
            }
        } catch (e) {}
        return 0;
    }

    /**
     * Programme l'affichage différé de la 1ʳᵉ question (après le countdown aligné).
     * IMPORTANT : piloté par le POLL, pas seulement par setTimeout. Sur un onglet en
     * arrière-plan (ex. fenêtre « Je participe aussi » laissée derrière le pilotage),
     * les navigateurs throttlent setTimeout à ~1/s → la question ne s'affichait jamais
     * et le timer expirait (« temps écoulé »). Le poll (qui continue, même throttlé)
     * sert de filet : processPendingReveal() révèle la question dès l'échéance atteinte.
     */
    function scheduleFirstQuestionReveal(qData, delayMs, qIndex) {
        const d = Math.max(0, delayMs);
        SESSION_STATE.pendingReveal = {
            qData: qData,
            revealAtMs: Date.now() + d,
            qIndex: (typeof qIndex === 'number') ? qIndex : (qData && qData.index)
        };
        if (SESSION_STATE.pendingRevealTimer) clearTimeout(SESSION_STATE.pendingRevealTimer);
        // Voie rapide en avant-plan (le poll reste le filet de sécurité).
        SESSION_STATE.pendingRevealTimer = setTimeout(processPendingReveal, d);
    }

    function processPendingReveal() {
        const pr = SESSION_STATE.pendingReveal;
        if (!pr) return;
        if (Date.now() < pr.revealAtMs) return;
        SESSION_STATE.pendingReveal = null;
        if (SESSION_STATE.pendingRevealTimer) {
            clearTimeout(SESSION_STATE.pendingRevealTimer);
            SESSION_STATE.pendingRevealTimer = null;
        }
        showQuestion(pr.qData);
    }

    function showQuestion(questionData) {
        console.log('📩 ÉLÈVE: Reçu événement question', questionData);
        console.log('📩 Stack trace:', new Error().stack);
        
        // Mettre à jour totalQuestions si fourni
        if (questionData.totalQuestions) {
            if (!SESSION_STATE.quizData) {
                SESSION_STATE.quizData = {};
            }
            SESSION_STATE.quizData.totalQuestions = questionData.totalQuestions;
            console.log('📊 ÉLÈVE: Total questions mis à jour:', questionData.totalQuestions);
        }
        
        // Le format peut varier selon la source (SSE vs polling)
        // Format polling: {index, data, startTime}
        // Format attendu par displayQuestion: {index, question, startTime}
        
        let formattedData;
        
        if (questionData.data) {
            // Format polling: adapter la structure MAIS conserver startTime ET totalQuestions
            formattedData = {
                index: questionData.index,
                question: questionData.data,
                startTime: questionData.startTime, // IMPORTANT : conserver le timestamp du serveur
                // SYNCHRO v2 : instant absolu d'apparition (ms serveur) + durée (ms) —
                // pour le timer visuel calé sur l'horloge synchronisée (cf. game.js).
                revealAt: questionData.revealAt,
                durationMs: questionData.durationMs,
                totalQuestions: questionData.totalQuestions // IMPORTANT : transférer le total
            };
            console.log('🔄 ÉLÈVE: Format adapté de polling vers display (startTime/revealAt et totalQuestions conservés)');
        } else {
            // Format déjà correct
            formattedData = questionData;
        }
        
        // Mettre à jour l'index de la question actuelle
        if (formattedData.index !== undefined) {
            console.log(`🔄 ÉLÈVE: Changement currentQuestion: ${SESSION_STATE.currentQuestion} -> ${formattedData.index}`);
            SESSION_STATE.currentQuestion = formattedData.index;
        }
        
        if (window.displayQuestion) {
            window.displayQuestion(formattedData);
            // La question est désormais RÉELLEMENT à l'écran : on le mémorise pour
            // l'auto-réparation (ensureQuestionDisplayed) et pour ne pas la ré-afficher.
            if (formattedData.index !== undefined) {
                SESSION_STATE.displayedQuestion = formattedData.index;
            }
            // Une éventuelle révélation en attente pour cette question est consommée.
            if (SESSION_STATE.pendingReveal && SESSION_STATE.pendingReveal.qIndex === formattedData.index) {
                SESSION_STATE.pendingReveal = null;
            }
        } else {
            console.error('❌ displayQuestion non défini !');
        }
    }

    /**
     * AUTO-RÉPARATION de l'affichage des questions (SELF-HEALING, idempotent). Appelée à
     * CHAQUE poll quand l'état est "playing" avec une question. Réconcilie l'écran avec
     * l'état serveur, sans dépendre de la détection d'une TRANSITION :
     *   - si la question courante est DÉJÀ à l'écran → rien à faire ;
     *   - si une révélation est programmée POUR cette question → on retente (filet
     *     anti-throttle d'arrière-plan : révèle dès l'échéance atteinte) ;
     *   - sinon : si l'instant de révélation (revealAt) est atteint → affichage immédiat ;
     *     s'il est encore à venir → compte à rebours (pour la 1ʳᵉ question seulement) +
     *     révélation programmée à l'instant absolu.
     * Corrige le bug du 18/06 (Q0 jamais affichée sur mobile : course visibilité/forceSync
     * au démarrage qui laissait le téléphone coincé sur le compte à rebours — Q1+ OK).
     */
    function ensureQuestionDisplayed(data) {
        const qIdx = data.currentQuestion;
        if (typeof qIdx !== 'number' || qIdx < 0 || !data.question) return;

        // Déjà à l'écran → rien à faire (et pas de ré-affichage qui réinitialiserait le timer).
        if (SESSION_STATE.displayedQuestion === qIdx) return;

        // Révélation déjà programmée POUR cette question : on laisse faire, en re-testant
        // l'échéance maintenant (le poll est le filet quand setTimeout est throttlé).
        if (SESSION_STATE.pendingReveal && SESSION_STATE.pendingReveal.qIndex === qIdx) {
            processPendingReveal();
            return;
        }

        SESSION_STATE.currentQuestion = qIdx;
        const delay = revealDelayMs(data);
        if (delay <= 0) {
            // Instant de révélation atteint/passé (ou détection tardive) → affichage immédiat.
            showQuestion(data.question);
        } else {
            // Pas encore l'heure : compte à rebours UNIQUEMENT pour la toute 1ʳᵉ question
            // (aucune question encore affichée) ; pour Q1+, l'écran de résultats reste
            // affiché jusqu'à l'instant absolu de révélation (pas de countdown intrusif).
            if (SESSION_STATE.displayedQuestion < 0) {
                startGame(data, delay);
            }
            scheduleFirstQuestionReveal(data.question, delay, qIdx);
        }
        boostIfNewTransition(qIdx, null);
    }

    function showResults(data) {
        if (window.displayQuestionResults) {
            window.displayQuestionResults(data);
        }
    }

    function endGame(data) {
        // Partie terminée : plus de reconnexion auto (un reload après la fin ramène à
        // l'accueil, pas dans une partie close).
        clearActiveSession();
        // Fermer le SSE pour arrêter tout flux d'événements
        if (SESSION_STATE.eventSource) {
            console.log('🔴 ÉLÈVE: Fermeture SSE (partie terminée)');
            SESSION_STATE.eventSource.close();
            SESSION_STATE.eventSource = null;
        }
        
        // Retirer l'overlay de pause si présent
        const pauseOverlay = document.getElementById('pause-overlay');
        if (pauseOverlay) {
            pauseOverlay.remove();
        }
        
        // Log des données reçues pour debug
        console.log('🔍 ÉLÈVE: Données endGame:', data);
        
        // Le serveur nous dit explicitement si la partie a commencé
        const gameStarted = data?.gameStarted === true;
        const hasPlayers = (data?.players || []).length > 0;
        // Garde anti-éjection (problème classe : une élève renvoyée à l'accueil) :
        // un payload de fin VIDE/tronqué (réponse coupée par un wifi instable au moment
        // exact de la fin) ne doit JAMAIS renvoyer un élève à la page d'accueil. On ne
        // renvoie à l'accueil que sur un signal POSITIF d'annulation (objet non vide
        // indiquant partie non démarrée / sans joueurs). Sinon on tente d'afficher les
        // résultats (no-op gracieux si vide → l'élève reste sur place, pas d'éjection).
        const isEmptyPayload = !data || Object.keys(data).length === 0;

        console.log('🔍 ÉLÈVE: gameStarted =', gameStarted, ', hasPlayers =', hasPlayers, ', empty =', isEmptyPayload);

        // Si la partie n'a pas commencé (salle d'attente), retourner à l'accueil
        if (!isEmptyPayload && (!gameStarted || !hasPlayers)) {
            console.log('🏠 ÉLÈVE: Partie annulée, retour à l\'accueil');
            
            // Nettoyer l'état
            SESSION_STATE.playCode = null;
            SESSION_STATE.playerNickname = null;
            
            // Retourner à la page d'accueil
            if (window.showPage) {
                window.showPage('home-page');
            }
            return;
        }
        
        // Sinon, afficher les résultats finaux
        console.log('🏁 ÉLÈVE: Affichage résultats finaux', data);
        if (window.displayFinalResults) {
            window.displayFinalResults(data);
        }
    }

    // ========================================
    // POLLING (FALLBACK SI SSE NE FONCTIONNE PAS)
    // ========================================
    
    let pollingTimer = null;
    let pollingActive = false;
    let lastStateHash = null;

    // Constantes de polling
    const REQUEST_TIMEOUT_MS = (window.CONFIG && window.CONFIG.REQUEST_TIMEOUT_MS) || 10000;
    const POLL_INTERVAL_QUESTION = (window.CONFIG && window.CONFIG.POLL_INTERVAL_QUESTION) || 2000;
    const POLL_INTERVAL_IDLE = (window.CONFIG && window.CONFIG.POLL_INTERVAL_IDLE) || 4000;
    const POLL_INTERVAL_LOBBY = (window.CONFIG && window.CONFIG.POLL_INTERVAL_LOBBY) || 2000;
    const POLL_INTERVAL_TRANSITION = (window.CONFIG && window.CONFIG.POLL_INTERVAL_TRANSITION) || 600;
    const POLL_TRANSITION_WINDOW_MS = (window.CONFIG && window.CONFIG.POLL_TRANSITION_WINDOW_MS) || 3000;
    const POLL_PRE_TRANSITION_SECONDS = (window.CONFIG && window.CONFIG.POLL_PRE_TRANSITION_SECONDS) || 2;
    const POLL_JITTER_RATIO = (window.CONFIG && window.CONFIG.POLL_JITTER_RATIO) || 0.15;
    const POLL_READONLY_RATIO = (window.CONFIG && window.CONFIG.POLL_READONLY_RATIO) || 6;
    const REVEAL_DELAY_MS = (window.CONFIG && window.CONFIG.REVEAL_DELAY_MS) || 1500;
    let pollCounter = 0;

    // ========================================
    // CIRCUIT BREAKER — anti-ban hébergeur
    // ========================================
    // Quand l'hébergeur (OVH mutualisé) renvoie 429/5xx ou drop silencieusement,
    // on n'a aucun intérêt à continuer à marteler : ça amplifie le ban. Le circuit
    // breaker compte les erreurs sur une fenêtre glissante et met le polling
    // physiquement en pause (1 à 5 min selon le palier) en respectant strictement
    // l'en-tête Retry-After si le serveur l'envoie.
    // UX : overlay non alarmiste avec compteur visible — pas de "Déconnecté".
    const CB_THRESHOLD = (window.CONFIG && window.CONFIG.CIRCUIT_BREAKER_THRESHOLD) || 3;
    const CB_WINDOW_MS = (window.CONFIG && window.CONFIG.CIRCUIT_BREAKER_WINDOW_MS) || 30000;
    const CB_PAUSES = (window.CONFIG && window.CONFIG.CIRCUIT_BREAKER_PAUSES) || [60000, 120000, 300000];
    const CB_MAX_RETRY_AFTER_MS = (window.CONFIG && window.CONFIG.CIRCUIT_BREAKER_MAX_RETRY_AFTER_MS) || 600000;

    let cbErrorTimestamps = [];
    let cbLevel = 0;
    let cbPausedUntil = 0;
    // Horodatage de la dernière sync serveur réussie (poll OU forceSync). Sert à
    // débouncer le forceSyncGameState déclenché au retour d'onglet : inutile (et
    // coûteux en requêtes → throttle) de re-frapper le serveur si on vient de le faire.
    let lastSyncTs = 0;
    let cbCountdownInterval = null;
    // Anti-tempête de renvoi des réponses : un seul answer_bulk à la fois (mono-vol) +
    // intervalle minimal entre deux envois. Sans ces gardes, retryPendingAnswers était
    // déclenché à chaque poll + chaque timer backoff → POST answer_bulk concurrents en
    // rafale → HTTP 500 OVH (épuisement process) le 06-09.
    let answerRetryInFlight = false;
    let lastAnswerRetryTs = 0;
    const MIN_ANSWER_RETRY_INTERVAL_MS = 2000;
    // Récupération "kicked" : un seul essai de ré-adhésion à la fois (mono-vol).
    let kickedRecoveryInFlight = false;

    function parseRetryAfterMs(response) {
        try {
            if (!response || !response.headers) return 0;
            const v = response.headers.get('Retry-After');
            if (!v) return 0;
            const n = parseFloat(v);
            if (!Number.isNaN(n) && n >= 0) {
                return Math.min(CB_MAX_RETRY_AFTER_MS, Math.round(n * 1000));
            }
            const t = Date.parse(v);
            if (!Number.isNaN(t)) {
                return Math.min(CB_MAX_RETRY_AFTER_MS, Math.max(0, t - Date.now()));
            }
        } catch (e) {}
        return 0;
    }

    // Contexte d'erreur pour l'observabilité (statut HTTP + nature). Permet de
    // distinguer dans les logs un 500 serveur, un throttle 429, un timeout, un réseau KO.
    function httpErrCtx(response) {
        const status = (response && response.status) || 0;
        return { status: status, kind: (status === 429 ? 'throttle' : 'http') };
    }
    function netErrCtx(error) {
        return { status: 0, kind: (error && error.name === 'AbortError') ? 'timeout' : 'network' };
    }

    function recordCircuitError(retryAfterMs, ctx) {
        const now = Date.now();
        ctx = ctx || {};
        // Observabilité : on trace CHAQUE erreur avec son STATUT (500/429/0) et sa NATURE
        // (http/throttle/timeout/network) — pour distinguer a posteriori un 500 serveur,
        // un throttle, un Wifi lent et un blocage par le filtrage du collège.
        recordClientEvent('http_error', { status: ctx.status, kind: ctx.kind, retryAfterMs: retryAfterMs });
        cbErrorTimestamps.push(now);
        cbErrorTimestamps = cbErrorTimestamps.filter(t => (now - t) <= CB_WINDOW_MS);

        if (retryAfterMs > 0) {
            // Le serveur (throttle applicatif ou hébergeur) nous dit combien attendre :
            // on respecte STRICTEMENT le Retry-After, mais on N'ESCALADE PAS cbLevel.
            // Un 429 de throttle n'est pas une panne réseau (le serveur est sain, 0 ms
            // de latence mesurée) : l'escalade ferait grimper la prochaine pause « seuil »
            // inutilement et poisonnait le breaker. cbLevel reste réservé aux vraies
            // erreurs de connectivité (timeouts/5xx) gérées dans la branche ci-dessous.
            cbPausedUntil = Math.max(cbPausedUntil, now + retryAfterMs);
            cbErrorTimestamps = [];
            console.warn('🔌 CB: pause imposée par serveur', Math.round(retryAfterMs / 1000), 's');
            recordClientEvent('cb_open', { reason: 'retry_after', pauseMs: retryAfterMs, level: cbLevel, status: ctx.status, kind: ctx.kind });
            showCircuitOverlay();
            // Envoi du diagnostic AU MOMENT DU BLOCAGE : si la classe se fige (tempête de
            // 500, serveur debout), ce beacon part quand même et explique la cause.
            flushClientEvents('cb_open');
        } else if (cbErrorTimestamps.length >= CB_THRESHOLD) {
            const idx = Math.min(cbLevel, CB_PAUSES.length - 1);
            const pauseMs = CB_PAUSES[idx];
            cbPausedUntil = Math.max(cbPausedUntil, now + pauseMs);
            cbLevel = Math.min(cbLevel + 1, CB_PAUSES.length - 1);
            cbErrorTimestamps = [];
            console.warn('🔌 CB: seuil atteint, pause', Math.round(pauseMs / 1000), 's (palier', cbLevel, ')');
            recordClientEvent('cb_open', { reason: 'threshold', pauseMs, level: cbLevel, status: ctx.status, kind: ctx.kind });
            showCircuitOverlay();
            flushClientEvents('cb_open');
        }
    }

    function resetCircuit() {
        if (cbErrorTimestamps.length === 0 && cbPausedUntil === 0 && cbLevel === 0) return;
        recordClientEvent('cb_close', { hadErrors: cbErrorTimestamps.length, prevLevel: cbLevel });
        cbErrorTimestamps = [];
        cbPausedUntil = 0;
        cbLevel = 0;
        hideCircuitOverlay();
    }

    function isCircuitPaused() {
        return Date.now() < cbPausedUntil;
    }

    function timeUntilCircuitReopens() {
        return Math.max(0, cbPausedUntil - Date.now());
    }

    function showCircuitOverlay() {
        let overlay = document.getElementById('circuit-overlay');
        if (!overlay) {
            // Nettoyer les anciens formats au cas où
            const oldError = document.getElementById('persistent-error');
            if (oldError) oldError.remove();
            const oldReconnect = document.getElementById('reconnecting-overlay');
            if (oldReconnect) oldReconnect.remove();

            overlay = document.createElement('div');
            overlay.id = 'circuit-overlay';
            overlay.style.cssText = 'position:fixed;top:20px;left:50%;transform:translateX(-50%);background:#fff;padding:14px 22px;border-radius:10px;box-shadow:0 4px 16px rgba(0,0,0,0.18);z-index:10000;display:flex;align-items:center;gap:12px;font-size:14px;color:#444;max-width:90%;border-left:4px solid #ff9800;';
            overlay.innerHTML = `
                <span id="circuit-icon" style="font-size:22px;">🔌</span>
                <div style="display:flex;flex-direction:column;gap:3px;min-width:230px;">
                    <span id="circuit-message">Connexion lente — reprise dans <strong id="circuit-countdown">…</strong></span>
                    <span id="circuit-submessage" style="font-size:12px;color:#888;"></span>
                </div>
            `;
            document.body.appendChild(overlay);
        }
        if (cbCountdownInterval) clearInterval(cbCountdownInterval);
        // Messages rotatifs : un collégien qui voit un écran figé recharge la page ou
        // martèle l'écran au bout de quelques secondes — on occupe l'attente, on
        // rassure sur les réponses, et on dit explicitement quoi NE PAS faire.
        const CB_SUBMESSAGES = [
            'Pas de panique : ça revient tout seul, ne recharge pas la page 😉',
            'Le wifi du collège fait une pause… nous aussi 😴',
            'Tes points sont à l\'abri, personne ne perd rien ✨',
            'La partie t\'attend, tu vas la retrouver exactement où elle en est 👍',
        ];
        const cbOpenedAt = Date.now();
        const tick = () => {
            const remaining = timeUntilCircuitReopens();
            const el = document.getElementById('circuit-countdown');
            const sub = document.getElementById('circuit-submessage');
            if (!el) return;
            if (remaining <= 0) {
                el.textContent = 'reprise…';
                if (sub) sub.textContent = 'Reconnexion en cours ⏳';
                if (cbCountdownInterval) { clearInterval(cbCountdownInterval); cbCountdownInterval = null; }
                return;
            }
            const sec = Math.ceil(remaining / 1000);
            el.textContent = sec >= 60 ? `${Math.floor(sec / 60)} min ${sec % 60}s` : `${sec}s`;
            if (sub) {
                // Priorité au message « réponse en sécurité » si une réponse attend
                const hasPending = (SESSION_STATE.pendingAnswers.length > 0) ||
                                   (Object.keys(awaitingConfirm).length > 0);
                if (hasPending) {
                    sub.textContent = '💾 Ta réponse est enregistrée : elle partira dès le retour du réseau';
                } else {
                    const idx = Math.floor((Date.now() - cbOpenedAt) / 4000) % CB_SUBMESSAGES.length;
                    sub.textContent = CB_SUBMESSAGES[idx];
                }
            }
        };
        tick();
        cbCountdownInterval = setInterval(tick, 1000);
    }

    function hideCircuitOverlay() {
        if (cbCountdownInterval) { clearInterval(cbCountdownInterval); cbCountdownInterval = null; }
        const overlay = document.getElementById('circuit-overlay');
        if (overlay) overlay.remove();
    }

    // Variables pour le watchdog anti-blocage (no-op conservé pour compatibilité)
    let watchdogTimer = null;
    let watchdogAttempts = 0;
    const WATCHDOG_MAX_ATTEMPTS = 3;
    
    /**
     * Choisit l'intervalle de polling suivant en fonction de l'état du jeu :
     *   - fenêtre de transition (post-changement < 4 s OU fin de question imminente
     *     i.e. timeRemaining < POLL_PRE_TRANSITION_SECONDS) → POLL_INTERVAL_TRANSITION (400 ms)
     *   - question active (currentQuestion >= 0 ET résultats pas encore affichés pour cette Q)
     *     → POLL_INTERVAL_QUESTION (1 s par défaut)
     *   - sinon (lobby, résultats affichés, finished) → POLL_INTERVAL_IDLE (2 s)
     * Ajoute un jitter aléatoire ±15 % pour éviter que tous les élèves frappent le serveur
     * en rythme synchrone (cas typique : reconnexion massive après une coupure Wifi du collège).
     */
    function nextPollDelay() {
        // Fenêtre de transition rapide après un changement serveur récent
        const ssc = SESSION_STATE.lastSecondsSinceLastChange;
        if (typeof ssc === 'number' && ssc * 1000 < POLL_TRANSITION_WINDOW_MS) {
            const jitter = (Math.random() * 2 - 1) * POLL_JITTER_RATIO;
            return Math.max(200, Math.round(POLL_INTERVAL_TRANSITION * (1 + jitter)));
        }
        // Fin de question imminente → fast-poll pour attraper la transition vers les résultats
        const qTime = SESSION_STATE.lastQuestionTimeSec;
        const qElapsed = SESSION_STATE.lastServerElapsedSec;
        if (typeof qTime === 'number' && typeof qElapsed === 'number' &&
            (qTime - qElapsed) <= POLL_PRE_TRANSITION_SECONDS &&
            (SESSION_STATE.currentQuestion ?? -1) >= 0 &&
            SESSION_STATE.lastDisplayedResultsQuestion !== SESSION_STATE.currentQuestion) {
            const jitter = (Math.random() * 2 - 1) * POLL_JITTER_RATIO;
            return Math.max(200, Math.round(POLL_INTERVAL_TRANSITION * (1 + jitter)));
        }
        // ANTICIPATION de l'avance automatique : en mode auto, la question suivante
        // part ~5 s après la complétion (auto-next pilote/projection). Fenêtre rapide
        // autour de cette échéance (de +3,5 s à +9 s, horloge serveur) pour que toute
        // la classe détecte la nouvelle question dans la même seconde — la révélation
        // alignée (startTime + 1,5 s) fait ensuite l'affichage au même instant absolu.
        if (!SESSION_STATE.lastCompletedManual &&
            typeof SESSION_STATE.lastCompletedAt === 'number' &&
            SESSION_STATE.lastDisplayedResultsQuestion === SESSION_STATE.currentQuestion &&
            SESSION_STATE.gameState === 'playing') {
            const serverNowSec = ((window.QwestClock && window.QwestClock.synced)
                ? window.QwestClock.now()
                : (Date.now() + (SESSION_STATE.serverClockOffsetMs || 0))) / 1000;
            const sinceCompleted = serverNowSec - SESSION_STATE.lastCompletedAt;
            if (sinceCompleted >= 3.5 && sinceCompleted <= 9) {
                const jitter = (Math.random() * 2 - 1) * POLL_JITTER_RATIO;
                return Math.max(200, Math.round(POLL_INTERVAL_TRANSITION * (1 + jitter)));
            }
            if (sinceCompleted >= 0 && sinceCompleted < 3.5) {
                // ATTERRISSAGE dans la fenêtre : sans ce plafond, un poll tombé juste
                // avant +3,5 s programmait le suivant à +interval de base (jusqu'à
                // 4 s × crowd 1,5 × jitter ≈ 7 s) et SAUTAIT par-dessus la fenêtre
                // d'anticipation → détection de la question suivante très en retard
                // pour cet élève (mesuré : 2,9 s d'écart en multi-classes).
                const landIn = (3.5 - sinceCompleted) * 1000 + 200 + Math.random() * 400;
                const jitter = (Math.random() * 2 - 1) * POLL_JITTER_RATIO;
                const normal = POLL_INTERVAL_IDLE * (typeof SESSION_STATE.crowdFactor === 'number' ? SESSION_STATE.crowdFactor : 1) * (1 + jitter);
                return Math.max(300, Math.round(Math.min(normal, landIn)));
            }
        }

        const isQuestionActive = (SESSION_STATE.currentQuestion ?? -1) >= 0 &&
                                 SESSION_STATE.lastDisplayedResultsQuestion !== SESSION_STATE.currentQuestion;
        // Salle d'attente : cadence dédiée (2 s) pour détecter le lancement de la partie
        // dans une fenêtre courte → décalage 1ʳᵉ question réduit. Résultats/Top3/finished
        // restent en IDLE (4 s), la fenêtre de transition gère déjà la question suivante.
        let base;
        if (isQuestionActive) {
            base = POLL_INTERVAL_QUESTION;
        } else if (SESSION_STATE.gameState === 'waiting') {
            base = POLL_INTERVAL_LOBBY;
        } else if (SESSION_STATE.gameState === 'playing' &&
                   SESSION_STATE.lastCompletedManual === true &&
                   SESSION_STATE.lastDisplayedResultsQuestion === SESSION_STATE.currentQuestion) {
            // Mode MANUEL, résultats affichés : impossible d'anticiper le clic du prof
            // (contrairement à l'avance auto) → cadence question (2,5 s) plutôt que
            // IDLE (4 s) pour resserrer la détection ; la révélation alignée (1,5 s)
            // absorbe l'essentiel de l'écart restant.
            base = POLL_INTERVAL_QUESTION;
        } else {
            base = POLL_INTERVAL_IDLE;
        }
        // Étalement multi-classes (hint serveur 'crowd' : 1 / 1,25 / 1,5 selon le nombre
        // de parties simultanées sur le compte) — uniquement sur le régime établi, les
        // fenêtres de transition ci-dessus restent à pleine vitesse.
        const crowd = (typeof SESSION_STATE.crowdFactor === 'number') ? SESSION_STATE.crowdFactor : 1;
        base = base * crowd;
        const jitter = (Math.random() * 2 - 1) * POLL_JITTER_RATIO;
        return Math.max(300, Math.round(base * (1 + jitter)));
    }

    /**
     * Programme le prochain poll. Si forceFastMs est fourni, utilise ce délai (en ms)
     * au lieu de l'intervalle adaptatif normal. Sert au "boost de transition" :
     * dès qu'un client détecte une nouvelle question ou des résultats, on accélère
     * le prochain poll pour rattraper rapidement l'info propagée par le serveur.
     */
    function scheduleNextPoll(forceFastMs) {
        if (!pollingActive) return;
        if (pollingTimer) clearTimeout(pollingTimer);
        let delay = (typeof forceFastMs === 'number') ? forceFastMs : nextPollDelay();
        // Circuit breaker : si en pause, attendre la réouverture au minimum
        const pauseDelay = timeUntilCircuitReopens();
        if (pauseDelay > 0) {
            delay = Math.max(delay, pauseDelay + 100);
        }
        pollingTimer = setTimeout(poll, delay);
    }

    const POLL_BOOST_MS = (window.CONFIG && window.CONFIG.POLL_BOOST_MS) || 200;
    let lastBoostedQuestion = -1;
    let lastBoostedResults = -1;
    /**
     * Demande un poll immédiat (200ms) si une transition vient d'être détectée.
     * Idempotent par changement (un seul boost par nouvelle question / par results).
     */
    function boostIfNewTransition(currentQ, hasNewResults) {
        let boosted = false;
        if (currentQ >= 0 && currentQ !== lastBoostedQuestion) {
            lastBoostedQuestion = currentQ;
            boosted = true;
        }
        if (hasNewResults && hasNewResults !== lastBoostedResults) {
            lastBoostedResults = hasNewResults;
            boosted = true;
        }
        if (boosted) scheduleNextPoll(POLL_BOOST_MS);
    }

    let poll; // déclaré ci-dessous

    function startPolling() {
        console.log('🔄 Démarrage du polling adaptatif (' + POLL_INTERVAL_QUESTION + '/' + POLL_INTERVAL_IDLE + ' ms ±' + Math.round(POLL_JITTER_RATIO * 100) + ' %)');
        SESSION_STATE.usingPolling = true;
        pollingActive = true;

        if (pollingTimer) {
            clearTimeout(pollingTimer);
            pollingTimer = null;
        }

        poll = async () => {
            if (!SESSION_STATE.playCode || !SESSION_STATE.playerNickname) {
                return;
            }

            // Filet de sécurité pour l'affichage différé de la 1ʳᵉ question : sur un
            // onglet en arrière-plan, setTimeout est throttlé ; le poll (qui continue)
            // révèle la question dès l'échéance atteinte. Vérifié à CHAQUE poll, avant
            // tout le reste (même en pause CB on a déjà la voie setTimeout).
            processPendingReveal();

            // Circuit breaker : si en pause, ne pas envoyer de requête
            if (isCircuitPaused()) {
                return;
            }

            let response = null;
            // 1 poll sur POLL_READONLY_RATIO est un get_state normal (refresh lastPing),
            // les autres sont des get_state_readonly (lecture pure, pas de flock côté serveur).
            // Conserve la cadence applicative tout en divisant le coût disque sur OVH.
            const useReadonly = (pollCounter++ % POLL_READONLY_RATIO) !== 0;
            const endpoint = useReadonly ? 'get_state_readonly' : 'get_state';
            const reqSentAt = Date.now();
            let reqRecvAt = reqSentAt;
            try {
                const controller = new AbortController();
                const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

                response = await fetch(
                    `php/game.php?action=${endpoint}&playCode=${SESSION_STATE.playCode}&nickname=${encodeURIComponent(SESSION_STATE.playerNickname)}`,
                    { signal: controller.signal }
                );
                clearTimeout(timeoutId);
                reqRecvAt = Date.now();

                // HTTP error (429/5xx/4xx) → circuit breaker, pas de retry agressif
                if (!response.ok) {
                    const retryAfterMs = parseRetryAfterMs(response);
                    console.warn('⚠️ Polling HTTP', response.status, 'retry-after:', Math.round(retryAfterMs / 1000), 's');
                    recordCircuitError(retryAfterMs, httpErrCtx(response));
                    return;
                }

                const data = await response.json();

                if (!data.success) {
                    // Réponse JSON valide mais success=false : kicked, session expirée, etc.
                    // PAS une erreur réseau → ne pas activer le circuit breaker.
                    console.log('⚠️ Polling échec applicatif:', data.message);
                    if (data.kicked) {
                        // « Joueur non trouvé » peut être TRANSITOIRE (lecture concurrente
                        // pendant un pic de charge) : avant, le polling tournait en boucle
                        // morte → élève figé / éjecté à l'accueil au reload. On tente une
                        // RÉ-ADHÉSION automatique (même pseudo + deviceId) : joinGame
                        // reconnecte le joueur existant (leave ne supprime pas) ou le
                        // ré-ajoute. Après 2 échecs réels consécutifs → accueil propre.
                        attemptKickedRecovery();
                        return;
                    }
                    return;
                }
                lastSyncTs = Date.now();

                // Succès → reset circuit breaker + renvoyer les pendingAnswers s'il y en a
                if (cbErrorTimestamps.length > 0 || cbPausedUntil > 0 || cbLevel > 0) {
                    console.log('✅ Connexion rétablie après pause CB');
                    resetCircuit();
                    hideConnectionWarning();
                    if (SESSION_STATE.pendingAnswers.length > 0) {
                        retryPendingAnswers();
                    }
                }

                // Confirmation des réponses : le serveur liste (myAnswered) les questions
                // où MA réponse est réellement enregistrée — ré-émission automatique sinon.
                if (data.myAnswered !== undefined) {
                    processAnswerConfirmations(data.myAnswered);
                }

                // Facteur d'étalement multi-classes (anti-ban hébergeur) : appliqué aux
                // intervalles de base par nextPollDelay() — jamais à la fenêtre de
                // transition (la réactivité aux changements reste maximale).
                if (typeof data.crowd === 'number' && data.crowd >= 1 && data.crowd <= 3) {
                    SESSION_STATE.crowdFactor = data.crowd;
                }

                // Hints pour l'ANTICIPATION de l'avance automatique (cf. nextPollDelay) :
                // instant de complétion + mode (l'avance auto part ~5 s après completedAt).
                if (typeof data.questionCompletedAt === 'number') {
                    SESSION_STATE.lastCompletedAt = data.questionCompletedAt;       // s serveur
                    SESSION_STATE.lastCompletedManual = !!data.manualMode;
                }
                // SYNCHRO v2 : affinage opportuniste de l'horloge (sans requête de plus).
                // observe() n'adopte que si ce RTT est meilleur que l'échantillon courant.
                if (typeof data.serverTimeMs === 'number' && window.QwestClock) {
                    window.QwestClock.observe(data.serverTimeMs, reqSentAt, reqRecvAt);
                }
                if (typeof data.serverTime === 'number') {
                    // Repli grossier conservé pour le cas (rare) où l'horloge n'est pas
                    // encore synchronisée (1ᵉʳ poll avant la fin du handshake).
                    SESSION_STATE.serverClockOffsetMs = data.serverTime * 1000 - Date.now();
                }

                // Mémoriser les hints serveur pour piloter nextPollDelay()
                if (typeof data.secondsSinceLastChange === 'number') {
                    SESSION_STATE.lastSecondsSinceLastChange = data.secondsSinceLastChange;
                }
                // Mémoriser l'état serveur pour piloter la cadence de polling : en salle
                // d'attente (waiting) on poll plus vite pour détecter le lancement vite.
                if (typeof data.state === 'string') {
                    SESSION_STATE.gameState = data.state;
                }
                if (data.question && data.question.data) {
                    const qTime = (data.question.data.time != null) ? Number(data.question.data.time) : null;
                    if (qTime != null && !Number.isNaN(qTime)) {
                        SESSION_STATE.lastQuestionTimeSec = qTime;
                    }
                    if (typeof data.serverTime === 'number' && typeof data.question.startTime === 'number') {
                        SESSION_STATE.lastServerElapsedSec = data.serverTime - data.question.startTime;
                    }
                }

                // Détecter les changements
                const stateHash = JSON.stringify({
                    state: data.state,
                    players: data.players.length,
                    currentQuestion: data.currentQuestion,
                    paused: data.paused
                });
                
                // Mise à jour des joueurs
                if (data.players) {
                    updatePlayersList(data.players);
                    
                    // Mettre à jour le score si on est sur la page de résultats
                    const resultsScreen = document.querySelector('.results-screen');
                    if (resultsScreen) {
                        const myData = data.players.find(p => p.nickname === SESSION_STATE.playerNickname);
                        if (myData) {
                            // Mettre à jour le score affiché
                            const scoreElement = document.querySelector('.score-value');
                            if (scoreElement) {
                                scoreElement.textContent = `${myData.score || 0} pts`;
                            }
                            
                            // Recalculer la position
                            const sortedPlayers = [...data.players].sort((a, b) => (b.score || 0) - (a.score || 0));
                            const myPosition = sortedPlayers.findIndex(p => p.nickname === SESSION_STATE.playerNickname) + 1;
                            const positionElement = document.querySelector('.position-value');
                            if (positionElement) {
                                positionElement.textContent = `#${myPosition}`;
                            }
                        }
                    }
                }
                
                // Démarrage du jeu + révélation des questions — AUTO-RÉPARANT.
                // On NE réagit PLUS aux seules transitions (currentQuestion qui change) :
                // à CHAQUE poll, ensureQuestionDisplayed réconcilie l'écran avec l'état
                // serveur. Si la révélation d'une question a été ratée dans une course
                // (bascules de visibilité mobile, forceSync au démarrage, throttle), le
                // poll suivant la rattrape. Q0 ET Q1+ passent par le MÊME chemin idempotent.
                if (data.state === 'playing') {
                    if (data.question && data.currentQuestion >= 0) {
                        SESSION_STATE.hasEnteredGame = true;
                        ensureQuestionDisplayed(data);
                    } else if (!SESSION_STATE.hasEnteredGame) {
                        // "playing" mais pas encore de question (écart start_game → next_question)
                        // → compte à rebours d'attente, affiché une seule fois.
                        console.log('🎮 Polling: démarrage détecté, attente de Q0');
                        SESSION_STATE.hasEnteredGame = true;
                        startGame(data);
                    }
                }

                // Résultats disponibles
                if (data.results) {
                    const questionIndex = data.results.questionIndex;
                    if (SESSION_STATE.lastDisplayedResultsQuestion !== questionIndex) {
                        console.log('✅ Polling: Nouveaux résultats pour question', questionIndex);
                        SESSION_STATE.lastDisplayedResultsQuestion = questionIndex;
                        showResults(data.results);
                        // Boost : la prochaine question peut arriver vite après les résultats
                        boostIfNewTransition(null, questionIndex);
                    }
                }
                
                // Pause
                if (data.paused !== SESSION_STATE.isPaused) {
                    SESSION_STATE.isPaused = data.paused;
                    if (window.handlePause) {
                        window.handlePause(data.paused);
                    }
                }
                
                // Fin du jeu
                if (data.state === 'finished') {
                    console.log('🏁 Polling: État finished détecté', {
                        hasFinalResults: !!data.finalResults,
                        finalResults: data.finalResults
                    });

                    pollingActive = false;
                    if (pollingTimer) {
                        clearTimeout(pollingTimer);
                        pollingTimer = null;
                        console.log('🛑 Polling: arrêté (finished)');
                    }

                    endGame(data.finalResults || {});
                    // Flush des logs client immédiatement à la fin de partie
                    // (ne pas attendre le beforeunload — le prof peut clore plus tard)
                    flushClientEvents('game_finished');
                    return; // pas de scheduleNextPoll
                }

                lastStateHash = stateHash;

            } catch (error) {
                // Timeout / réseau coupé / DNS / etc. → circuit breaker
                console.error('❌ Erreur polling réseau:', error.name || error);
                recordCircuitError(0, netErrCtx(error));
            } finally {
                scheduleNextPoll();
            }
        };

        // Amorce : premier polling immédiat. Les suivants sont réarmés par scheduleNextPoll
        // dans le `finally` de poll(), avec un intervalle adaptatif et du jitter.
        poll();
    }

    // ========================================
    // DÉCONNEXION AUTOMATIQUE
    // ========================================
    
    // Confirmation + notification "leave" avant déchargement (reload / fermeture /
    // retour). Évite qu'une mauvaise manipulation n'éjecte l'élève sans prévenir, et
    // au retour la reconnexion auto (sessionStorage) le replace dans la partie.
    window.addEventListener('beforeunload', function(e) {
        if (!SESSION_STATE.playCode || !SESSION_STATE.playerNickname) return;

        // Notifier le serveur (best-effort, sendBeacon = fiable au déchargement).
        // On NE coupe PAS le polling ici : si l'élève annule (« Rester »), il doit
        // continuer à jouer normalement (le prochain poll le re-marque connecté). Si
        // la page se décharge vraiment, tout s'arrête de toute façon.
        try {
            navigator.sendBeacon('php/game.php', new URLSearchParams({
                action: 'leave',
                playCode: SESSION_STATE.playCode,
                nickname: SESSION_STATE.playerNickname
            }));
        } catch (err) {}

        // Demander confirmation TANT QUE la partie n'est pas terminée (à la fin, on
        // laisse l'élève fermer sans friction). Le texte est imposé par le navigateur
        // (générique) ; l'essentiel est le garde-fou contre le clic/reload accidentel.
        if (SESSION_STATE.gameState !== 'finished') {
            e.preventDefault();
            e.returnValue = '';
            return '';
        }
    });

    // ========================================
    // VISIBILITY API : rattrapage instantané au retour de l'onglet en avant-plan
    // ========================================
    // Les navigateurs throttlent setTimeout (~1/s) sur les onglets/popups en arrière-plan.
    // Cela touche en particulier la fenêtre prof "Je participe aussi" quand le prof est
    // sur la fenêtre de pilotage. Au retour, on force un poll immédiat puis on accélère.
    // Anti-triche « avertir seulement » : signale au prof qu'un élève a quitté l'onglet
    // pendant une question (beacon débouncé) et mémorise pour l'avertir au retour. PAS
    // de déconnexion (décision validée) → la reconnexion est transparente.
    let lastTabSwitchReportTs = 0;
    function handleTabHidden() {
        if (!SESSION_STATE.playCode || !SESSION_STATE.playerNickname) return;
        if (SESSION_STATE.gameState !== 'playing') return; // ni en lobby, ni en résultats
        SESSION_STATE.leftTabDuringGame = true;
        const debounce = (window.CONFIG && window.CONFIG.TAB_SWITCH_DEBOUNCE_MS) || 3000;
        if (Date.now() - lastTabSwitchReportTs < debounce) return;
        lastTabSwitchReportTs = Date.now();
        try {
            navigator.sendBeacon('php/game.php', new URLSearchParams({
                action: 'report_tab_switch',
                playCode: SESSION_STATE.playCode,
                nickname: SESSION_STATE.playerNickname
            }));
        } catch (e) {}
    }
    function showTabSwitchWarning() {
        showStudentNotice('Reste sur le jeu ! Quitter la page pendant une question est signalé au professeur.', true);
    }

    document.addEventListener('visibilitychange', function() {
        recordClientEvent('visibility_change', { state: document.visibilityState });
        if (document.visibilityState !== 'visible') {
            // L'élève QUITTE l'onglet/la fenêtre → signalement prof (anti-triche).
            handleTabHidden();
            // Envoi du diagnostic en arrière-plan (fiable sur mobile, contrairement à
            // beforeunload). flushClientEvents ne fait rien si le buffer est vide.
            flushClientEvents('hidden');
            return;
        }
        if (!SESSION_STATE.playCode || !SESSION_STATE.playerNickname) return;

        // Au retour : d'abord révéler une éventuelle question en attente (filet
        // anti-throttle d'arrière-plan), puis avertir si l'élève avait quitté pendant
        // une question.
        processPendingReveal();
        if (SESSION_STATE.leftTabDuringGame) {
            SESSION_STATE.leftTabDuringGame = false;
            showTabSwitchWarning();
        }

        // Anti-rafale (cause n°1 des HTTP 429 auto-infligés en classe) : sur mobile,
        // l'écran se verrouille/déverrouille et bascule d'app en permanence. Sans
        // garde-fou, CHAQUE retour déclenchait une requête forceSync immédiate + un
        // poll boosté → dépassement du throttle 75 req/min → pause. On ne force une
        // requête immédiate QUE si la dernière sync date de plus de 1,5 s (sinon le
        // cycle de polling normal, relancé juste après, suffit largement).
        const sinceSync = Date.now() - lastSyncTs;
        if (sinceSync > 1500) {
            try {
                // forceRedisplay = true : autorise un re-render de la question même si
                // l'index n'a pas changé (le navigateur a pu interrompre le DOM en
                // arrière-plan). forceSyncGameState ne re-render que si l'écran manque.
                forceSyncGameState({ forceRedisplay: true });
            } catch (e) {
                console.warn('visibilitychange forceSync error:', e);
            }
        }
        // Boost doux : un seul poll un peu plus tôt (600 ms), jamais un martèlement.
        // Le prochain poll est forcé en variante ÉCRIVAINE (pollCounter = 0) pour
        // rafraîchir lastPing : forceSyncGameState étant passé en lecture seule, c'est
        // ce poll qui signale « je suis revenu » au serveur (statut connecté du prof).
        if (pollingActive) {
            pollCounter = 0;
            scheduleNextPoll(POLL_BOOST_MS);
        }
    });

    // ========================================
    // FLUSH DES LOGS CLIENT
    // ========================================
    // Envoi du buffer d'événements diagnostiques au beforeunload (1 seule requête,
    // sendBeacon = fiable au moment du déchargement) et au pagehide (iOS Safari).
    window.addEventListener('beforeunload', function() {
        flushClientEvents('beforeunload');
    });
    window.addEventListener('pagehide', function() {
        flushClientEvents('pagehide');
    });

    // ========================================
    // EXPORT VERS GLOBAL
    // ========================================

    window.SESSION_STATE = SESSION_STATE;
    window.initStudentSession = initStudentSession;
    window.setPlayerInfo = setPlayerInfo;
    window.joinSession = joinSession;
    window.submitAnswer = submitAnswer;
    window.retryPendingAnswers = retryPendingAnswers;
    window.leaveSession = leaveSession;
    window.tryRejoinActiveSession = tryRejoinActiveSession;
    window.getSchools = getSchools;
    window.getSessionState = getSessionState;
    window.startWatchdog = startWatchdog;
    window.stopWatchdog = stopWatchdog;
    // Permet à control.js (depuis l'opener) de pousser une resync immédiate
    // sur la fenêtre teacher-play après une action prof (next/start/pause/end).
    window.forceSyncGameState = forceSyncGameState;

})();
