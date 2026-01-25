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
        pendingAnswers: []  // Réponses en attente de renvoi après déconnexion
    };

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
        SESSION_STATE.score = 0;
        SESSION_STATE.answers = [];
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
    async function joinSession() {
        console.log('🔵 Tentative de rejoindre la session:', {
            playCode: SESSION_STATE.playCode,
            nickname: SESSION_STATE.playerNickname
        });
        
        try {
            const response = await fetch('php/game.php', {
                method: 'POST',
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                body: new URLSearchParams({
                    action: 'join',
                    playCode: SESSION_STATE.playCode,
                    nickname: SESSION_STATE.playerNickname
                })
            });

            const result = await response.json();
            console.log('🔵 Réponse joinSession:', result);

            if (result.success) {
                // Connecter au flux SSE
                connectToEventStream();
                return true;
            } else {
                console.error('❌ Échec joinSession:', result.message);
                alert('❌ Impossible de rejoindre : ' + (result.message || 'Erreur inconnue'));
                return false;
            }

        } catch (error) {
            console.error('❌ Erreur lors de la connexion:', error);
            alert('❌ Erreur de connexion au serveur');
            return false;
        }
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
        
        try {
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

            const result = await response.json();
            
            if (result.success) {
                console.log('✅ ÉLÈVE: Réponse envoyée avec succès');
                return true;
            } else {
                console.warn('⚠️ ÉLÈVE: Échec envoi réponse (serveur)');
                // Stocker pour renvoi ultérieur
                storePendingAnswer(answer, timeSpent, SESSION_STATE.currentQuestion);
                return false;
            }

        } catch (error) {
            console.error('❌ ÉLÈVE: Erreur envoi réponse (réseau):', error);
            // Stocker pour renvoi ultérieur
            storePendingAnswer(answer, timeSpent, SESSION_STATE.currentQuestion);
            return false;
        }
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
        
        console.log('🔄 ÉLÈVE: Renvoi de', SESSION_STATE.pendingAnswers.length, 'réponse(s) en attente');
        
        const toRetry = [...SESSION_STATE.pendingAnswers];
        SESSION_STATE.pendingAnswers = [];
        
        for (const pending of toRetry) {
            try {
                const response = await fetch('php/game.php', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                    body: new URLSearchParams({
                        action: 'answer',
                        playCode: SESSION_STATE.playCode,
                        nickname: SESSION_STATE.playerNickname,
                        questionIndex: pending.questionIndex,
                        answer: JSON.stringify(pending.answer),
                        timeSpent: pending.timeSpent
                    })
                });
                
                const result = await response.json();
                
                if (result.success) {
                    console.log('✅ ÉLÈVE: Réponse renvoyée avec succès', pending.questionIndex);
                } else {
                    console.warn('⚠️ ÉLÈVE: Échec renvoi, remise en attente', pending.questionIndex);
                    SESSION_STATE.pendingAnswers.push(pending);
                }
            } catch (error) {
                console.error('❌ ÉLÈVE: Erreur renvoi, remise en attente', error);
                SESSION_STATE.pendingAnswers.push(pending);
            }
        }
        
        if (SESSION_STATE.pendingAnswers.length > 0) {
            console.warn('⚠️ ÉLÈVE:', SESSION_STATE.pendingAnswers.length, 'réponse(s) encore en attente');
        } else {
            console.log('✅ ÉLÈVE: Toutes les réponses en attente ont été envoyées');
            hideConnectionWarning();
            
            // IMPORTANT : Forcer une synchronisation immédiate de l'état du jeu
            // pour récupérer les résultats/état actuel qu'on a manqués pendant la déconnexion
            console.log('🔄 ÉLÈVE: Synchronisation de l\'état du jeu...');
            await forceSyncGameState();
        }
    }
    
    /**
     * Forcer une synchronisation immédiate de l'état du jeu
     * Utilisé après reconnexion pour récupérer l'état manqué pendant la déconnexion
     */
    async function forceSyncGameState() {
        try {
            const response = await fetch(`php/game.php?action=get_state&playCode=${SESSION_STATE.playCode}&nickname=${encodeURIComponent(SESSION_STATE.playerNickname)}`);
            const data = await response.json();
            
            if (!data.success) {
                console.warn('⚠️ ÉLÈVE: Échec sync état');
                return;
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
            
            // Si une nouvelle question est disponible
            if (data.state === 'playing' && data.question) {
                if (data.currentQuestion !== SESSION_STATE.currentQuestion) {
                    console.log('📩 ÉLÈVE: Affichage de la question manquée (question', data.currentQuestion, ')');
                    SESSION_STATE.currentQuestion = data.currentQuestion;
                    if (window.showQuestion) {
                        showQuestion(data.question);
                    }
                }
            }
            
        } catch (error) {
            console.error('❌ ÉLÈVE: Erreur sync état:', error);
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
     * Le watchdog vérifie périodiquement si la question devrait être terminée
     */
    function startWatchdog(questionIndex, expectedEndTime) {
        // Arrêter tout watchdog précédent
        stopWatchdog();
        
        watchdogAttempts = 0;
        
        // Calculer le délai avant la première vérification
        // On attend 5 secondes après la fin théorique du timer
        const delay = Math.max(5000, (expectedEndTime - Date.now()) + 5000);
        
        console.log(`🐕 WATCHDOG: Démarré pour Q${questionIndex}, vérification dans ${Math.round(delay/1000)}s`);
        
        watchdogTimer = setTimeout(() => {
            checkWatchdog(questionIndex);
        }, delay);
    }
    
    /**
     * Arrêter le watchdog
     */
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
                // Réessayer dans 5 secondes
                console.log(`🐕 WATCHDOG: Pas encore complétée, nouvelle tentative dans 5s`);
                watchdogTimer = setTimeout(() => {
                    checkWatchdog(questionIndex);
                }, 5000);
            } else {
                // Après plusieurs tentatives, afficher un message
                console.warn('🐕 WATCHDOG: Max tentatives atteint, affichage du message');
                const stuckWarning = document.getElementById('stuck-warning');
                if (stuckWarning) {
                    stuckWarning.style.display = 'block';
                    stuckWarning.innerHTML = `
                        ⚠️ La synchronisation prend du temps...<br>
                        <small>Le professeur peut utiliser le bouton "Resynchroniser" pour débloquer.</small>
                        <br><br>
                        <button onclick="manualResyncRequest()" style="padding: 8px 16px; background: #ffc107; border: none; border-radius: 4px; cursor: pointer;">
                            🔄 Demander une resync
                        </button>
                    `;
                }
            }
        } catch (error) {
            console.error('🐕 WATCHDOG: Erreur', error);
            
            if (watchdogAttempts < WATCHDOG_MAX_ATTEMPTS) {
                watchdogTimer = setTimeout(() => {
                    checkWatchdog(questionIndex);
                }, 5000);
            }
        }
    }
    
    /**
     * Demande manuelle de resync par l'élève
     */
    window.manualResyncRequest = async function() {
        console.log('🔄 ÉLÈVE: Demande manuelle de resync');
        
        try {
            const response = await fetch(`php/game.php?action=check_question_timeout&playCode=${SESSION_STATE.playCode}&nickname=${encodeURIComponent(SESSION_STATE.playerNickname)}&questionIndex=${SESSION_STATE.currentQuestion}`);
            const data = await response.json();
            
            if (data.success && data.questionCompleted && data.results) {
                SESSION_STATE.lastDisplayedResultsQuestion = data.results.questionIndex;
                if (window.displayQuestionResults) {
                    window.displayQuestionResults(data.results);
                }
            } else {
                alert('⏳ Le serveur n\'a pas encore les résultats. Attendez que le professeur utilise le bouton "Resynchroniser".');
            }
        } catch (error) {
            console.error('Erreur resync manuelle:', error);
            alert('❌ Erreur de connexion. Réessayez.');
        }
    };

    /**
     * Quitter la session
     */
    function leaveSession() {
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

    function startGame(data) {
        if (window.handleGameStart) {
            window.handleGameStart(data);
        }
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
                totalQuestions: questionData.totalQuestions // IMPORTANT : transférer le total
            };
            console.log('🔄 ÉLÈVE: Format adapté de polling vers display (startTime et totalQuestions conservés)');
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
        } else {
            console.error('❌ displayQuestion non défini !');
        }
    }

    function showResults(data) {
        if (window.displayQuestionResults) {
            window.displayQuestionResults(data);
        }
    }

    function endGame(data) {
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
        
        console.log('🔍 ÉLÈVE: gameStarted =', gameStarted, ', hasPlayers =', hasPlayers);
        
        // Si la partie n'a pas commencé (salle d'attente), retourner à l'accueil
        if (!gameStarted || !hasPlayers) {
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
    
    let pollingInterval = null;
    let lastStateHash = null;
    let consecutiveFailures = 0;
    let isReconnecting = false;
    
    // Constantes pour la récupération automatique
    const RECONNECT_THRESHOLD = 3;       // Tentatives avant reconnexion
    const MAX_RECONNECT_ATTEMPTS = 5;    // Tentatives max de reconnexion
    const HARD_RESET_THRESHOLD = 15;     // Tentatives avant reset complet
    const STALE_CONNECTION_TIMEOUT = 10000; // 10 secondes sans réponse = bloqué
    const RECOVERY_RETRY_DELAY = 1000;   // 1 seconde entre tentatives de récupération
    
    let reconnectAttempts = 0;
    let lastSuccessfulPoll = Date.now();
    
    // Variables pour le watchdog anti-blocage
    let watchdogTimer = null;
    let watchdogAttempts = 0;
    const WATCHDOG_MAX_ATTEMPTS = 3;
    
    // Vérifier si on est bloqué depuis trop longtemps
    function checkForStaleConnection() {
        const timeSinceSuccess = Date.now() - lastSuccessfulPoll;
        if (timeSinceSuccess > STALE_CONNECTION_TIMEOUT && !isReconnecting) {
            console.log('⚠️ Connexion bloquée depuis', Math.round(timeSinceSuccess/1000), 's - tentative de récupération');
            attemptRecovery();
        }
    }
    
    // Tentative de récupération automatique
    async function attemptRecovery() {
        if (isReconnecting || SESSION_STATE.wasKicked) return;
        
        isReconnecting = true;
        reconnectAttempts++;
        
        console.log('🔄 Tentative de récupération', reconnectAttempts, '/', MAX_RECONNECT_ATTEMPTS);
        
        hideConnectionWarning();
        
        try {
            const joinResponse = await fetch('php/game.php', {
                method: 'POST',
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                body: new URLSearchParams({
                    action: 'join',
                    playCode: SESSION_STATE.playCode,
                    nickname: SESSION_STATE.playerNickname
                })
            });
            
            const joinResult = await joinResponse.json();
            
            if (joinResult.success) {
                console.log('✅ Récupération réussie - reconnecté');
                consecutiveFailures = 0;
                reconnectAttempts = 0;
                lastSuccessfulPoll = Date.now();
                isReconnecting = false;
                retryPendingAnswers();
                return true;
            } else {
                console.log('⚠️ Join échoué:', joinResult.message);
            }
        } catch (error) {
            console.error('❌ Erreur lors de la récupération:', error);
        }
        
        isReconnecting = false;
        
        if (reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
            console.log('❌ Récupération impossible après', reconnectAttempts, 'tentatives');
            showPersistentError();
        } else {
            setTimeout(() => attemptRecovery(), RECOVERY_RETRY_DELAY);
        }
        
        return false;
    }
    
    // Afficher une erreur persistante avec option de rafraîchissement
    function showPersistentError() {
        if (document.getElementById('persistent-error')) return;
        
        const errorDiv = document.createElement('div');
        errorDiv.id = 'persistent-error';
        errorDiv.style.cssText = 'position:fixed;top:50%;left:50%;transform:translate(-50%,-50%);background:#fff;padding:30px;border-radius:15px;box-shadow:0 10px 40px rgba(0,0,0,0.3);text-align:center;z-index:10000;max-width:90%;';
        errorDiv.innerHTML = `
            <div style="font-size:48px;margin-bottom:15px;">📡</div>
            <h2 style="color:#d32f2f;margin-bottom:15px;">Connexion perdue</h2>
            <p style="color:#666;margin-bottom:20px;">La connexion avec le serveur a été interrompue.<br>Clique sur le bouton pour te reconnecter.</p>
            <button onclick="location.reload()" style="background:#4CAF50;color:white;border:none;padding:15px 30px;border-radius:10px;font-size:18px;cursor:pointer;font-weight:bold;">
                🔄 Reconnecter
            </button>
        `;
        document.body.appendChild(errorDiv);
    }
    
    function startPolling() {
        console.log('🔄 Démarrage du mode polling adaptatif');
        SESSION_STATE.usingPolling = true;
        consecutiveFailures = 0;
        reconnectAttempts = 0;
        lastSuccessfulPoll = Date.now();
        
        if (pollingInterval) {
            clearInterval(pollingInterval);
        }
        
        // Vérification périodique de connexion bloquée (toutes les 5s)
        setInterval(checkForStaleConnection, 5000);
        
        // Fonction de polling
        const poll = async () => {
            if (!SESSION_STATE.playCode || !SESSION_STATE.playerNickname) {
                return;
            }
            
            try {
                const controller = new AbortController();
                const timeoutId = setTimeout(() => controller.abort(), 5000); // Timeout 5s
                
                const response = await fetch(
                    `php/game.php?action=get_state&playCode=${SESSION_STATE.playCode}&nickname=${encodeURIComponent(SESSION_STATE.playerNickname)}`,
                    { signal: controller.signal }
                );
                clearTimeout(timeoutId);
                
                const data = await response.json();
                
                if (!data.success) {
                    consecutiveFailures++;
                    console.log('⚠️ Échec polling:', data.message, '(', consecutiveFailures, 'consécutifs)');
                    
                    if (data.kicked && !SESSION_STATE.wasKicked) {
                        if (consecutiveFailures >= RECONNECT_THRESHOLD && !isReconnecting) {
                            attemptRecovery();
                        }
                    }
                    return;
                }
                
                // Succès !
                lastSuccessfulPoll = Date.now();
                
                if (consecutiveFailures > 0) {
                    console.log('✅ Connexion rétablie (après', consecutiveFailures, 'échecs)');
                    hideConnectionWarning();
                    retryPendingAnswers();
                }
                consecutiveFailures = 0;
                reconnectAttempts = 0;
                
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
                
                // Démarrage du jeu + première question
                if (data.state === 'playing') {
                    // Si on a une question à afficher
                    if (data.question) {
                        // Vérifier si c'est une nouvelle question (différente de celle actuellement affichée)
                        if (data.currentQuestion !== SESSION_STATE.currentQuestion) {
                            console.log('📩 Polling: Nouvelle question détectée', {
                                serveurQuestion: data.currentQuestion, 
                                clientQuestion: SESSION_STATE.currentQuestion,
                                timestamp: new Date().toISOString()
                            });
                            SESSION_STATE.currentQuestion = data.currentQuestion;
                            showQuestion(data.question);
                        } else {
                            console.log('⏭️ Polling: Question inchangée, pas de mise à jour');
                        }
                    } 
                    // Sinon, si c'est le premier passage en 'playing', afficher le compte à rebours
                    else if (!lastStateHash || !lastStateHash.includes('"state":"playing"')) {
                        console.log('🎮 Polling: Démarrage du jeu détecté (compte à rebours)');
                        startGame(data);
                    }
                }
                
                // Résultats disponibles
                if (data.results) {
                    const questionIndex = data.results.questionIndex;
                    
                    console.log('📊 Polling: Résultats détectés', {
                        questionIndex: questionIndex,
                        hasTop3: !!data.results.top3,
                        lastDisplayedQuestion: SESSION_STATE.lastDisplayedResultsQuestion
                    });
                    
                    // N'afficher les résultats qu'une seule fois par question
                    // (ignorer les mises à jour de score qui changeraient le hash)
                    if (SESSION_STATE.lastDisplayedResultsQuestion !== questionIndex) {
                        console.log('✅ Polling: Nouveaux résultats pour question', questionIndex);
                        SESSION_STATE.lastDisplayedResultsQuestion = questionIndex;
                        showResults(data.results);
                    } else {
                        console.log('⏭️ Polling: Résultats déjà affichés pour cette question');
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
                    
                    if (pollingInterval) {
                        clearInterval(pollingInterval);
                        console.log('🛑 Polling: Intervalle arrêté');
                    }
                    
                    // Envoyer les résultats finaux (même s'ils sont vides)
                    endGame(data.finalResults || {});
                }
                
                lastStateHash = stateHash;
                
            } catch (error) {
                console.error('❌ Erreur polling:', error);
            }
        };
        
        // Première requête immédiate
        poll();
        
        // Puis toutes les 2 secondes (au lieu de 1s) - RÉDUCTION DE 50%
        pollingInterval = setInterval(poll, 2000); // 2 secondes pour limiter les requêtes
    }

    // ========================================
    // DÉCONNEXION AUTOMATIQUE
    // ========================================
    
    // Marquer comme déconnecté quand on ferme l'onglet
    window.addEventListener('beforeunload', function() {
        if (SESSION_STATE.playCode && SESSION_STATE.playerNickname) {
            // Arrêter le polling
            if (pollingInterval) {
                clearInterval(pollingInterval);
            }
            
            // Envoi synchrone pour garantir l'exécution
            const data = new URLSearchParams({
                action: 'leave',
                playCode: SESSION_STATE.playCode,
                nickname: SESSION_STATE.playerNickname
            });
            
            // Utiliser sendBeacon pour envoi garanti
            navigator.sendBeacon('php/game.php', data);
        }
    });

    // ========================================
    // EXPORT VERS GLOBAL
    // ========================================
    
    window.SESSION_STATE = SESSION_STATE;
    window.initStudentSession = initStudentSession;
    window.setPlayerInfo = setPlayerInfo;
    window.joinSession = joinSession;
    window.submitAnswer = submitAnswer;
    window.leaveSession = leaveSession;
    window.getSchools = getSchools;
    window.getSessionState = getSessionState;
    window.startWatchdog = startWatchdog;
    window.stopWatchdog = stopWatchdog;

})();
