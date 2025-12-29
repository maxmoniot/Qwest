// ============================================
// MODULE: CONTROL PANEL (Pilotage)
// Description: Interface de pilotage de la partie pour le professeur
// ============================================

(function() {
    'use strict';

    // État du contrôle
    const CONTROL_STATE = {
        sessionId: null,
        playCode: null,
        quizData: null,
        schoolName: '',
        manualMode: false,
        showTop3: true,
        customTime: null,
        isPaused: false,
        currentQuestion: -1,
        players: [],
        autoNextTimer: null,
        autoNextTimestamp: null,
        autoNextQuestionPending: false,
        autoNextCheckInterval: null
    };

    // ========================================
    // MODALE PERSONNALISÉE
    // ========================================
    
    function showCustomAlert(title, message, icon = '✅') {
        // Créer la modale
        const modalHTML = `
            <div class="custom-alert-overlay" onclick="closeCustomAlert()">
                <div class="custom-alert-box" onclick="event.stopPropagation()">
                    <div class="custom-alert-icon">${icon}</div>
                    <h3 class="custom-alert-title">${title}</h3>
                    <p class="custom-alert-message">${message}</p>
                    <button class="custom-alert-btn" onclick="closeCustomAlert()">OK</button>
                </div>
            </div>
        `;
        
        // Supprimer l'ancienne modale si elle existe
        const oldModal = document.getElementById('custom-alert');
        if (oldModal) oldModal.remove();
        
        // Ajouter la nouvelle
        const modalDiv = document.createElement('div');
        modalDiv.id = 'custom-alert';
        modalDiv.innerHTML = modalHTML;
        document.body.appendChild(modalDiv);
    }
    
    window.closeCustomAlert = function() {
        const modal = document.getElementById('custom-alert');
        if (modal) modal.remove();
    };
    
    function showCustomConfirm(title, message, onConfirm, icon = '❓') {
        // Créer la modale
        const modalHTML = `
            <div class="custom-alert-overlay" onclick="closeCustomConfirm(false)">
                <div class="custom-alert-box" onclick="event.stopPropagation()">
                    <div class="custom-alert-icon">${icon}</div>
                    <h3 class="custom-alert-title">${title}</h3>
                    <p class="custom-alert-message">${message}</p>
                    <div class="custom-alert-buttons">
                        <button class="custom-alert-btn-secondary" onclick="closeCustomConfirm(false)">Annuler</button>
                        <button class="custom-alert-btn" onclick="closeCustomConfirm(true)">Confirmer</button>
                    </div>
                </div>
            </div>
        `;
        
        // Supprimer l'ancienne modale si elle existe
        const oldModal = document.getElementById('custom-confirm');
        if (oldModal) oldModal.remove();
        
        // Ajouter la nouvelle
        const modalDiv = document.createElement('div');
        modalDiv.id = 'custom-confirm';
        modalDiv.innerHTML = modalHTML;
        document.body.appendChild(modalDiv);
        
        // Stocker le callback
        window._confirmCallback = onConfirm;
    }
    
    window.closeCustomConfirm = function(confirmed) {
        // Récupérer les valeurs AVANT de supprimer la modale
        const inputValue = document.getElementById('new-score-input')?.value;
        
        const modal = document.getElementById('custom-confirm');
        if (modal) modal.remove();
        
        if (window._confirmCallback) {
            // Passer la valeur au callback si elle existe
            if (inputValue !== undefined) {
                window._confirmCallbackData = inputValue;
            }
            window._confirmCallback(confirmed);
            window._confirmCallback = null;
            window._confirmCallbackData = null;
        }
    };

    // ========================================
    // OUVRIR LE PANNEAU DE CONTRÔLE
    // ========================================
    
    function openControlPanel() {
        if (APP_STATE.questions.length === 0) {
            alert('⚠️ Vous devez d\'abord créer des questions.');
            return;
        }

        const modal = document.getElementById('control-modal');
        const panel = modal.querySelector('.control-panel');
        
        // Générer un nouveau code de partie unique
        const newPlayCode = generatePlayCode();
        
        // Initialiser l'état
        CONTROL_STATE.playCode = newPlayCode;
        CONTROL_STATE.quizData = {
            questions: APP_STATE.questions,
            name: document.getElementById('quiz-name-input')?.value || 'Mon Quiz'
        };
        CONTROL_STATE.sessionId = newPlayCode;
        CONTROL_STATE.manualMode = false;
        CONTROL_STATE.showTop3 = true;
        
        // Afficher directement l'interface de pilotage
        showControlInterface();
        
        modal.classList.add('active');
    }

    function openTeacherPlay() {
        if (!CONTROL_STATE.playCode) {
            alert('⚠️ Aucune partie en cours');
            return;
        }
        
        // Ouvrir teacher-play.html dans un nouvel onglet avec le code
        teacherWindow = window.open(`teacher-play.html?code=${CONTROL_STATE.playCode}`, '_blank');
        
        if (!teacherWindow) {
            alert('❌ Impossible d\'ouvrir la fenêtre. Vérifiez que les popups ne sont pas bloquées.');
        } else {
            console.log('👨‍🏫 TEACHER: Fenêtre ouverte');
            
            // Démarrer les updates si pas déjà en cours (au cas où projection n'est pas ouverte)
            if (!projectionUpdateInterval) {
                console.log('👨‍🏫 TEACHER: Démarrage des mises à jour...');
                setTimeout(() => {
                    startProjectionUpdates();
                    setTimeout(() => {
                        updateProjectionWindow();
                    }, 100);
                }, 1000);
            }
            
            // Gérer la fermeture
            const checkClosed = setInterval(() => {
                if (teacherWindow.closed) {
                    clearInterval(checkClosed);
                    teacherWindow = null;
                    console.log('👨‍🏫 TEACHER: Fenêtre fermée');
                }
            }, 1000);
        }
    }

    async function closeControlPanel() {
        // Fermer la popup IMMÉDIATEMENT pour ne pas bloquer l'interface
        document.getElementById('control-modal').classList.remove('active');
        
        // Réinitialiser l'état local immédiatement
        const playCodeToCleanup = CONTROL_STATE.playCode;
        
        CONTROL_STATE.playCode = null;
        CONTROL_STATE.quizData = null;
        CONTROL_STATE.players = [];
        CONTROL_STATE.currentQuestion = -1;
        CONTROL_STATE.isPaused = false;
        
        // Arrêter le polling immédiatement
        if (controlPollingInterval) {
            console.log('🔴 PROF: Arrêt du polling...');
            clearInterval(controlPollingInterval);
            controlPollingInterval = null;
        }
        
        // Faire le reste en ARRIÈRE-PLAN (non bloquant)
        if (playCodeToCleanup) {
            (async () => {
                try {
                    // Envoyer end_game aux élèves
                    await fetch('php/control.php', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                        body: new URLSearchParams({
                            action: 'end_game',
                            playCode: playCodeToCleanup
                        })
                    });
                    
                    console.log('🏁 PROF: Partie terminée (arrière-plan)');
                    
                    // Attendre que les élèves reçoivent l'événement
                    await new Promise(resolve => setTimeout(resolve, 2000));
                    
                    // Cleanup de la session
                    await fetch('php/control.php', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                        body: new URLSearchParams({
                            action: 'cleanup_session',
                            playCode: playCodeToCleanup
                        })
                    });
                    
                    console.log('🧹 PROF: Nettoyage terminé (arrière-plan)');
                    
                } catch (error) {
                    console.error('Erreur cleanup arrière-plan:', error);
                }
            })();
        }
    }

    // ========================================
    // CRÉER LA SESSION CÔTÉ SERVEUR
    // ========================================
    
    async function createSessionOnServer() {
        // Lire les valeurs des checkboxes MAINTENANT
        const checkManual = document.getElementById('manual-mode-check');
        const checkTop3 = document.getElementById('show-top3-check');
        
        CONTROL_STATE.manualMode = checkManual ? checkManual.checked : false;
        CONTROL_STATE.showTop3 = checkTop3 ? checkTop3.checked : true;
        
        console.log('🟢 PROF: Création de session côté serveur', {
            playCode: CONTROL_STATE.playCode,
            questionsCount: APP_STATE.questions.length,
            manualMode: CONTROL_STATE.manualMode,
            showTop3: CONTROL_STATE.showTop3
        });
        
        try {
            const response = await fetch('php/control.php', {
                method: 'POST',
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                body: new URLSearchParams({
                    action: 'create_session',
                    playCode: CONTROL_STATE.playCode,
                    quizData: JSON.stringify(CONTROL_STATE.quizData),
                    manualMode: CONTROL_STATE.manualMode ? '1' : '0',
                    showTop3: CONTROL_STATE.showTop3 ? '1' : '0'
                })
            });
            
            const result = await response.json();
            console.log('🟢 PROF: Réponse création session', result);
            
            if (result.success) {
                console.log('✅ PROF: Session créée avec succès, connexion SSE...');
                
                // Activer le bouton Projection dès que la session est créée
                const btnProjection = document.getElementById('btn-projection');
                if (btnProjection) btnProjection.disabled = false;
                
                // Connecter au flux SSE
                connectControlStream();
            } else {
                console.error('❌ PROF: Échec création session', result.message);
                alert('❌ Erreur : ' + result.message);
            }
            
        } catch (error) {
            console.error('❌ PROF: Erreur création session:', error);
            alert('❌ Erreur de connexion au serveur');
        }
    }

    // ========================================
    // INTERFACE DE PILOTAGE
    // ========================================
    
    function showControlInterface() {
        const panel = document.querySelector('.control-panel');
        
        // Afficher le code dans le header de la modale
        const codeDisplay = document.getElementById('control-code-display');
        codeDisplay.innerHTML = `
            <button class="btn-copy-header" onclick="copyToClipboard('${CONTROL_STATE.playCode}')">
                📋 Copier
            </button>
            <div class="code-info">
                <span class="code-label">Code :</span>
                <span class="code-value">${CONTROL_STATE.playCode}</span>
            </div>
        `;
        
        panel.innerHTML = `
            <div class="control-interface">
                <!-- Options de jeu -->
                <div class="control-section">
                    <h4>⚙️ Options de jeu</h4>
                    <div class="control-options">
                        <label class="control-checkbox">
                            <input type="checkbox" 
                                   id="manual-mode-check" 
                                   ${CONTROL_STATE.manualMode ? 'checked' : ''}
                                   onchange="toggleManualMode()">
                            <span>Mode manuel (avancer manuellement)</span>
                        </label>
                        
                        <label class="control-checkbox">
                            <input type="checkbox" 
                                   id="show-top3-check" 
                                   ${CONTROL_STATE.showTop3 ? 'checked' : ''}
                                   onchange="toggleShowTop3()">
                            <span>Afficher le Top 3 après chaque question</span>
                        </label>
                        
                        <label class="control-checkbox control-checkbox-inline">
                            <input type="checkbox" 
                                   id="custom-time-check">
                            <div class="checkbox-inline-content">
                                <span>Forcer temps par question à :</span>
                                <input type="number" 
                                       id="custom-time-input" 
                                       class="time-input-inline"
                                       value="30" 
                                       min="5" 
                                       max="300">
                                <span class="time-unit">s</span>
                            </div>
                        </label>
                        
                        <label class="control-checkbox control-checkbox-inline">
                            <input type="checkbox" 
                                   id="limit-questions-check">
                            <div class="checkbox-inline-content">
                                <span>Limiter à</span>
                                <input type="number" 
                                       id="limit-questions-input" 
                                       class="time-input-inline"
                                       value="10" 
                                       min="1" 
                                       max="${APP_STATE.questions.length}">
                                <span class="time-unit">questions <span class="option-hint">(aléatoires)</span></span>
                            </div>
                        </label>
                    </div>
                </div>
                
                <!-- Participants -->
                <div class="control-section">
                    <div class="section-header">
                        <h4>👥 Participants connectés : <span id="control-player-count">0</span></h4>
                        <div class="section-header-buttons">
                            <button class="btn-small" onclick="refreshPlayers()">🔄 Actualiser</button>
                            <button id="btn-resync" class="btn-small" onclick="forceResync()" disabled title="Force les élèves à se resynchroniser en cas de blocage">
                                🔄 Resynchroniser
                            </button>
                        </div>
                    </div>
                    <div id="control-players-list" class="control-players-list">
                        <div class="empty-list">Aucun joueur pour le moment</div>
                    </div>
                </div>
                
                <!-- Contrôles -->
                <div class="control-section">
                    <div class="section-header">
                        <h4>🎛️ Contrôles</h4>
                        <button id="btn-projection" class="btn-small btn-projection" onclick="openProjectionMode()" disabled title="Mode projection pour afficher aux élèves">
                            📽️ Projection
                        </button>
                    </div>
                    <div class="control-buttons">
                        <button id="btn-start-game" class="btn-control btn-success" onclick="startGame()">
                            ▶️ Lancer la partie
                        </button>
                        <button id="btn-pause-game" class="btn-control btn-warning" onclick="pauseGame()" disabled>
                            ⏸️ Pause
                        </button>
                        <button id="btn-next-question" class="btn-control btn-primary" onclick="nextQuestion()" disabled>
                            ⏭️ Question suivante
                        </button>
                        <button id="btn-end-game" class="btn-control btn-danger" onclick="endGame()" disabled>
                            ⏹️ Terminer
                        </button>
                        <button class="btn-control btn-info" onclick="showGradingTable()" style="grid-column: span 2;">
                            📊 Tableau de suivi complet
                        </button>
                    </div>
                </div>
                
                <!-- Progress -->
                <div class="control-section">
                    <div class="section-header">
                        <h4>📊 Progression</h4>
                        <button id="btn-preview-question" class="btn-small btn-preview" onclick="toggleQuestionPreview()" disabled title="Aperçu de la question en cours">
                            👁️ Aperçu question en cours
                        </button>
                    </div>
                    <div class="question-progress-bar">
                        <div class="progress-fill" id="question-progress" style="width: 0%"></div>
                    </div>
                    <p class="progress-text">
                        Question <span id="current-q-num">0</span> / <span id="total-q-num">${APP_STATE.questions.length}</span>
                    </p>
                </div>
            </div>
        `;
        
        // Créer la session côté serveur (qui va aussi mettre à jour le nombre de questions)
        createSessionOnServer();
    }

    function toggleManualMode() {
        const checkbox = document.getElementById('manual-mode-check');
        CONTROL_STATE.manualMode = checkbox.checked;
    }

    function toggleShowTop3() {
        const checkbox = document.getElementById('show-top3-check');
        CONTROL_STATE.showTop3 = checkbox.checked;
    }
    
    // ========================================
    // CONNEXION AU FLUX SSE (CONTRÔLE)
    // ========================================
    
    function connectControlStream() {
        console.log('🟢 PROF: Démarrage du polling');
        startControlPolling();
    }

    function updateControlPlayersList(players) {
        // Vérifier si les données ont réellement changé
        const currentPlayersJSON = JSON.stringify(CONTROL_STATE.players || []);
        const newPlayersJSON = JSON.stringify(players || []);
        
        if (currentPlayersJSON === newPlayersJSON) {
            // Aucun changement, ne rien faire
            return;
        }
        
        CONTROL_STATE.players = players;
        
        const list = document.getElementById('control-players-list');
        const count = document.getElementById('control-player-count');
        
        if (!list || !count) return;
        
        count.textContent = players.length;
        
        if (players.length === 0) {
            list.innerHTML = '<div class="empty-list">Aucun joueur pour le moment</div>';
            return;
        }
        
        let html = '';
        players.forEach((player, index) => {
            const statusClass = player.connected ? 'connected' : 'disconnected';
            const statusIcon = player.connected ? '🟢' : '🔴';
            
            // Calculer le nombre de bonnes réponses
            const totalQuestions = CONTROL_STATE.quizData?.questions?.length || 0;
            let correctAnswers = 0;
            if (player.answers) {
                Object.values(player.answers).forEach(answer => {
                    if (answer.correct) correctAnswers++;
                });
            }
            
            html += `
                <div class="control-player-item ${statusClass}">
                    <span class="player-status">${statusIcon}</span>
                    <span class="player-nick">${player.nickname}</span>
                    <span class="player-progress">✓ ${correctAnswers}/${totalQuestions}</span>
                    <span class="player-score" id="score-${index}">${player.score || 0} pts</span>
                    <div class="player-actions">
                        <button class="btn-icon" onclick="editPlayerScore('${player.nickname}', ${index})" title="Modifier score">
                            ✏️
                        </button>
                        <button class="btn-icon btn-danger" onclick="removePlayer('${player.nickname}')" title="Supprimer">
                            🗑️
                        </button>
                    </div>
                </div>
            `;
        });
        
        list.innerHTML = html;
    }

    function updateAnswersCount(data) {
        // Mettre à jour le compteur de réponses en temps réel
        // (Affichage optionnel pendant qu'une question est active)
    }
    
    async function editPlayerScore(nickname, index) {
        const currentScore = CONTROL_STATE.players[index].score || 0;
        
        console.log('✏️ PROF: Édition score pour', nickname, 'index', index, 'score actuel', currentScore);
        
        showCustomConfirm(
            'Modifier le score',
            `<input type="number" id="new-score-input" value="${currentScore}" min="0" style="width: 100%; padding: 10px; font-size: 18px; border: 2px solid var(--primary); border-radius: 8px; margin-top: 10px;">`,
            async (confirmed) => {
                if (!confirmed) return;
                
                // Utiliser la valeur sauvegardée par closeCustomConfirm
                const newScore = parseInt(window._confirmCallbackData || 0);
                
                console.log('📤 PROF: Envoi update score:', {
                    playCode: CONTROL_STATE.playCode,
                    nickname: nickname,
                    score: newScore
                });
                
                try {
                    const response = await fetch('php/control.php', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                        body: new URLSearchParams({
                            action: 'update_player_score',
                            playCode: CONTROL_STATE.playCode,
                            nickname: nickname,
                            score: newScore
                        })
                    });
                    
                    const result = await response.json();
                    console.log('📥 PROF: Réponse update score:', result);
                    
                    if (result.success) {
                        // Mise à jour visuelle immédiate
                        CONTROL_STATE.players[index].score = newScore;
                        document.getElementById(`score-${index}`).textContent = `${newScore} pts`;
                        console.log('✅ PROF: Score mis à jour localement');
                    } else {
                        console.error('❌ PROF: Échec update score');
                    }
                } catch (error) {
                    console.error('❌ Erreur mise à jour score:', error);
                }
            },
            '✏️'
        );
    }
    
    async function removePlayer(nickname) {
        showCustomConfirm(
            'Supprimer le joueur ?',
            `Voulez-vous vraiment supprimer ${nickname} de la partie ?`,
            async (confirmed) => {
                if (!confirmed) return;
                
                try {
                    const response = await fetch('php/control.php', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                        body: new URLSearchParams({
                            action: 'remove_player',
                            playCode: CONTROL_STATE.playCode,
                            nickname: nickname
                        })
                    });
                    
                    const result = await response.json();
                    if (result.success) {
                        console.log('✅ PROF: Joueur supprimé');
                    }
                } catch (error) {
                    console.error('❌ Erreur suppression joueur:', error);
                }
            },
            '⚠️'
        );
    }
    
    window.editPlayerScore = editPlayerScore;
    window.removePlayer = removePlayer;

    // ========================================
    // ACTIONS DE CONTRÔLE
    // ========================================
    
    async function startGame() {
        if (CONTROL_STATE.players.length === 0) {
            showCustomConfirm(
                'Aucun joueur connecté',
                'Aucun élève n\'a rejoint la partie. Voulez-vous quand même la lancer ?',
                async (confirmed) => {
                    if (confirmed) {
                        await launchGame();
                    }
                },
                '⚠️'
            );
            return;
        }
        
        await launchGame();
    }
    
    async function launchGame() {
        try {
            // Lire les valeurs des checkboxes MAINTENANT (pas à l'ouverture)
            const checkManual = document.getElementById('manual-mode-check');
            const checkTop3 = document.getElementById('show-top3-check');
            const checkCustomTime = document.getElementById('custom-time-check');
            const inputCustomTime = document.getElementById('custom-time-input');
            const checkLimitQuestions = document.getElementById('limit-questions-check');
            const limitQuestionsInput = document.getElementById('limit-questions-input');
            
            CONTROL_STATE.manualMode = checkManual ? checkManual.checked : false;
            CONTROL_STATE.showTop3 = checkTop3 ? checkTop3.checked : true;
            
            // Lire le temps personnalisé si la case est cochée
            if (checkCustomTime && checkCustomTime.checked && inputCustomTime) {
                CONTROL_STATE.customTime = parseInt(inputCustomTime.value) || 30;
                console.log('⏱️ PROF: Temps personnalisé activé:', CONTROL_STATE.customTime, 'secondes');
            } else {
                CONTROL_STATE.customTime = null;
                console.log('⏱️ PROF: Temps personnalisé désactivé');
            }
            
            // Gérer la limitation des questions MAINTENANT (au lancement)
            let questionsToUse = APP_STATE.questions;
            
            if (checkLimitQuestions && checkLimitQuestions.checked) {
                const limit = parseInt(limitQuestionsInput.value) || 10;
                if (limit < APP_STATE.questions.length) {
                    // Mélanger et prendre les N premières
                    const shuffled = [...APP_STATE.questions].sort(() => Math.random() - 0.5);
                    questionsToUse = shuffled.slice(0, limit);
                    console.log(`🎲 PROF: ${limit} questions sélectionnées aléatoirement sur ${APP_STATE.questions.length}`);
                }
            }
            
            // Mettre à jour quizData avec les questions sélectionnées
            CONTROL_STATE.quizData.questions = questionsToUse;
            
            // Mettre à jour le nombre de questions affiché
            const totalQNum = document.getElementById('total-q-num');
            if (totalQNum) {
                totalQNum.textContent = questionsToUse.length;
            }
            
            // Mettre à jour les questions sur le serveur SANS toucher aux joueurs
            await fetch('php/control.php', {
                method: 'POST',
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                body: new URLSearchParams({
                    action: 'update_questions',
                    playCode: CONTROL_STATE.playCode,
                    questions: JSON.stringify(questionsToUse),
                    quizData: JSON.stringify(CONTROL_STATE.quizData)
                })
            });
            
            console.log('🎮 PROF: Lancement avec', questionsToUse.length, 'questions, manualMode =', CONTROL_STATE.manualMode);
            
            const response = await fetch('php/control.php', {
                method: 'POST',
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                body: new URLSearchParams({
                    action: 'start_game',
                    playCode: CONTROL_STATE.playCode,
                    manualMode: CONTROL_STATE.manualMode ? '1' : '0',
                    showTop3: CONTROL_STATE.showTop3 ? '1' : '0'
                })
            });
            
            const result = await response.json();
            
            if (result.success) {
                // Désactiver le bouton start et activer les autres
                const btnStart = document.getElementById('btn-start-game');
                const btnPause = document.getElementById('btn-pause-game');
                const btnEnd = document.getElementById('btn-end-game');
                const btnProjection = document.getElementById('btn-projection');
                const checkManual = document.getElementById('manual-mode-check');
                const checkTop3 = document.getElementById('show-top3-check');
                const checkCustomTime = document.getElementById('custom-time-check');
                const checkLimitQuestions = document.getElementById('limit-questions-check');
                const inputLimitQuestions = document.getElementById('limit-questions-input');
                const inputCustomTime = document.getElementById('custom-time-input');
                
                if (btnStart) btnStart.disabled = true;
                if (btnPause) btnPause.disabled = false;
                if (btnEnd) btnEnd.disabled = false;
                if (btnProjection) btnProjection.disabled = false;
                
                // Activer le bouton de resynchronisation
                const btnResync = document.getElementById('btn-resync');
                if (btnResync) btnResync.disabled = false;
                
                // Désactiver les options
                if (checkManual) checkManual.disabled = true;
                if (checkTop3) checkTop3.disabled = true;
                if (checkCustomTime) checkCustomTime.disabled = true;
                if (checkLimitQuestions) checkLimitQuestions.disabled = true;
                if (inputLimitQuestions) inputLimitQuestions.disabled = true;
                if (inputCustomTime) inputCustomTime.disabled = true;
                
                // Lancer la première question (toujours, même en mode manuel)
                setTimeout(() => {
                    nextQuestion();
                    
                    // Toujours activer le bouton "Question suivante" pour permettre au prof d'avancer
                    document.getElementById('btn-next-question').disabled = false;
                }, 3000);
            }
            
        } catch (error) {
            console.error('Erreur démarrage:', error);
            alert('❌ Erreur lors du démarrage');
        }
    }

    async function pauseGame() {
        CONTROL_STATE.isPaused = !CONTROL_STATE.isPaused;
        
        const btn = document.getElementById('btn-pause-game');
        
        if (btn) {
            if (CONTROL_STATE.isPaused) {
                btn.textContent = '▶️ Reprendre';
            } else {
                btn.textContent = '⏸️ Pause';
            }
        }
        
        // Notifier le serveur
        await fetch('php/control.php', {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({
                action: 'pause_game',
                playCode: CONTROL_STATE.playCode,
                paused: CONTROL_STATE.isPaused ? '1' : '0'
            })
        });
    }

    async function nextQuestion() {
        if (CONTROL_STATE.isPaused) {
            alert('⚠️ La partie est en pause');
            return;
        }
        
        // IMPORTANT : Annuler le passage automatique en attente
        // Si le prof clique manuellement, on ne veut pas que le timer auto lance la question suivante
        if (CONTROL_STATE.autoNextQuestionPending) {
            console.log('🛑 PROF: Annulation du passage auto (clic manuel)');
            CONTROL_STATE.autoNextQuestionPending = false;
        }
        
        CONTROL_STATE.currentQuestion++;
        
        // Utiliser le nombre de questions réellement jouées (limitées)
        const totalQuestions = CONTROL_STATE.quizData?.questions?.length || APP_STATE.questions.length;
        
        if (CONTROL_STATE.currentQuestion >= totalQuestions) {
            // Fin naturelle de la partie - pas de confirmation
            console.log('🏁 PROF: Fin de partie atteinte (question', CONTROL_STATE.currentQuestion, '>=', totalQuestions, ')');
            endGame(true);
            return;
        }
        
        try {
            const params = {
                action: 'next_question',
                playCode: CONTROL_STATE.playCode,
                questionIndex: CONTROL_STATE.currentQuestion,
                customTime: CONTROL_STATE.customTime // Toujours envoyer (peut être null)
            };
            
            console.log('🎯 PROF: Envoi nextQuestion avec params:', params);
            
            const response = await fetch('php/control.php', {
                method: 'POST',
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                body: new URLSearchParams(params)
            });
            
            const result = await response.json();
            
            if (result.success) {
                // Mettre à jour la progression
                updateQuestionProgress();
            }
            
        } catch (error) {
            console.error('Erreur question suivante:', error);
        }
    }

    function updateQuestionProgress() {
        const currentNum = CONTROL_STATE.currentQuestion + 1;
        const total = CONTROL_STATE.quizData?.questions?.length || APP_STATE.questions.length;
        const percentage = (currentNum / total) * 100;
        
        document.getElementById('current-q-num').textContent = currentNum;
        document.getElementById('total-q-num').textContent = total;
        document.getElementById('question-progress').style.width = percentage + '%';
        
        // Activer le bouton d'aperçu si une question est en cours
        const btnPreview = document.getElementById('btn-preview-question');
        if (btnPreview && CONTROL_STATE.currentQuestion >= 0) {
            btnPreview.disabled = false;
        }
    }

    async function endGame(skipConfirm = false) {
        if (!skipConfirm) {
            showCustomConfirm(
                'Terminer la partie ?',
                'Voulez-vous vraiment terminer la partie maintenant ? Les résultats finaux seront envoyés aux élèves.',
                async (confirmed) => {
                    if (!confirmed) return;
                    await executeEndGame();
                },
                '⚠️'
            );
            return;
        }
        
        await executeEndGame();
    }
    
    async function executeEndGame() {
        try {
            // Fermer le SSE prof avant de terminer
            // Arrêter le polling
            if (controlPollingInterval) {
                console.log('🔴 PROF: Arrêt du polling...');
                clearInterval(controlPollingInterval);
                controlPollingInterval = null;
                console.log('✅ PROF: Polling arrêté');
            }
            
            const response = await fetch('php/control.php', {
                method: 'POST',
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                body: new URLSearchParams({
                    action: 'end_game',
                    playCode: CONTROL_STATE.playCode
                })
            });
            
            const result = await response.json();
            
            console.log('🏁 PROF: Réponse end_game:', result);
            
            if (result.success) {
                console.log('✅ PROF: Partie terminée avec succès');
                
                // Désactiver tous les boutons
                const btnPause = document.getElementById('btn-pause-game');
                const btnNext = document.getElementById('btn-next-question');
                const btnEnd = document.getElementById('btn-end-game');
                const btnStart = document.getElementById('btn-start-game');
                
                if (btnPause) {
                    btnPause.disabled = true;
                    btnPause.style.opacity = '0.4';
                    btnPause.style.cursor = 'not-allowed';
                }
                if (btnNext) {
                    btnNext.disabled = true;
                    btnNext.style.opacity = '0.4';
                    btnNext.style.cursor = 'not-allowed';
                }
                if (btnEnd) {
                    btnEnd.disabled = true;
                    btnEnd.style.opacity = '0.4';
                    btnEnd.style.cursor = 'not-allowed';
                }
                if (btnStart) {
                    btnStart.disabled = true;
                    btnStart.style.opacity = '0.4';
                    btnStart.style.cursor = 'not-allowed';
                }
                
                showCustomAlert('Partie terminée !', 'La partie est maintenant terminée. Les résultats finaux ont été envoyés aux élèves.', '🎉');
            } else {
                console.error('❌ PROF: Erreur end_game:', result.message || 'Aucun message');
                showCustomAlert('Erreur', 'Une erreur est survenue lors de la fin de partie.', '❌');
            }
            
        } catch (error) {
            console.error('Erreur fin de partie:', error);
        }
    }
    
    // Fonction appelée depuis la projection pour terminer directement (confirmation déjà faite)
    window.executeEndGameFromProjection = async function() {
        await executeEndGame();
    };

    function refreshPlayers() {
        // Force un refresh de la liste
        connectControlStream();
    }

    function showFullScoreboard() {
        // Ouvrir une popup avec le tableau complet des scores
        const scoreboard = document.createElement('div');
        scoreboard.className = 'scoreboard-modal';
        scoreboard.innerHTML = `
            <div class="scoreboard-content">
                <div class="scoreboard-header">
                    <h3>📊 Tableau complet des scores</h3>
                    <button class="close-btn" onclick="this.closest('.scoreboard-modal').remove()">×</button>
                </div>
                <div class="scoreboard-body">
                    <table class="scoreboard-table">
                        <thead>
                            <tr>
                                <th>#</th>
                                <th>Joueur</th>
                                <th>Collège</th>
                                <th>Score</th>
                            </tr>
                        </thead>
                        <tbody id="scoreboard-tbody">
                            ${generateScoreboardRows()}
                        </tbody>
                    </table>
                </div>
            </div>
        `;
        document.body.appendChild(scoreboard);
    }

    function generateScoreboardRows() {
        if (CONTROL_STATE.players.length === 0) {
            return '<tr><td colspan="4" style="text-align:center">Aucun joueur</td></tr>';
        }
        
        // Trier par score
        const sorted = [...CONTROL_STATE.players].sort((a, b) => b.score - a.score);
        
        return sorted.map((player, index) => `
            <tr>
                <td>${index + 1}</td>
                <td>${player.nickname}</td>
                <td>${player.schoolName}</td>
                <td><strong>${player.score}</strong></td>
            </tr>
        `).join('');
    }

    function showGradingTable() {
        const totalQuestions = CONTROL_STATE.quizData?.questions?.length || 0;
        
        // Calculer les stats pour chaque joueur
        const playersData = CONTROL_STATE.players.map(player => {
            let correctAnswers = 0;
            if (player.answers) {
                Object.values(player.answers).forEach(answer => {
                    if (answer.correct) correctAnswers++;
                });
            }
            
            // Calcul de la note sur 20
            const grade = totalQuestions > 0 ? ((correctAnswers / totalQuestions) * 20).toFixed(1) : '0.0';
            
            return {
                nickname: player.nickname,
                correctAnswers: correctAnswers,
                totalQuestions: totalQuestions,
                score: player.score || 0,
                grade: grade
            };
        });
        
        // Trier par nombre de bonnes réponses (puis par score)
        playersData.sort((a, b) => {
            if (b.correctAnswers !== a.correctAnswers) {
                return b.correctAnswers - a.correctAnswers;
            }
            return b.score - a.score;
        });
        
        // Créer la modale
        const modalHTML = `
            <div class="custom-alert-overlay grading-overlay" onclick="closeGradingTable(event)">
                <div class="grading-modal" onclick="event.stopPropagation()">
                    <div class="grading-header">
                        <h3>📊 Tableau de suivi complet</h3>
                        <button class="close-btn" onclick="closeGradingTable()">×</button>
                    </div>
                    <div class="grading-body">
                        <div class="grading-actions">
                            <button class="btn-secondary" onclick="exportGradingCSV()">📥 Exporter CSV</button>
                            <button class="btn-secondary" onclick="printGradingTable()">🖨️ Imprimer</button>
                        </div>
                        <table class="grading-table" id="grading-table">
                            <thead>
                                <tr>
                                    <th>#</th>
                                    <th>Élève</th>
                                    <th>Réussite</th>
                                    <th>Score</th>
                                    <th>Note /20</th>
                                </tr>
                            </thead>
                            <tbody id="grading-table-body">
                                ${playersData.map((player, index) => `
                                    <tr class="clickable-row" onclick="showPlayerRecap('${player.nickname.replace(/'/g, "\\'")}')">
                                        <td>${index + 1}</td>
                                        <td class="student-name">${player.nickname}</td>
                                        <td class="success-rate">
                                            <span class="success-badge">${player.correctAnswers}/${player.totalQuestions}</span>
                                            <span class="success-percent">${totalQuestions > 0 ? Math.round((player.correctAnswers / player.totalQuestions) * 100) : 0}%</span>
                                        </td>
                                        <td class="score-cell">${player.score} pts</td>
                                        <td class="grade-cell">
                                            <span class="grade-value">${player.grade}</span>
                                        </td>
                                    </tr>
                                `).join('')}
                            </tbody>
                        </table>
                    </div>
                </div>
            </div>
        `;
        
        // Supprimer l'ancienne modale si elle existe
        const oldModal = document.getElementById('grading-modal');
        if (oldModal) oldModal.remove();
        
        // Ajouter la nouvelle
        const modalDiv = document.createElement('div');
        modalDiv.id = 'grading-modal';
        modalDiv.innerHTML = modalHTML;
        document.body.appendChild(modalDiv);
        
        // Démarrer la mise à jour en temps réel
        startGradingTableUpdates();
    }
    
    let gradingUpdateInterval = null;
    
    function startGradingTableUpdates() {
        // Nettoyer l'ancien interval s'il existe
        if (gradingUpdateInterval) {
            clearInterval(gradingUpdateInterval);
        }
        
        // Mettre à jour toutes les 2 secondes
        gradingUpdateInterval = setInterval(() => {
            const modal = document.getElementById('grading-modal');
            if (!modal) {
                // La modale est fermée, arrêter les mises à jour
                clearInterval(gradingUpdateInterval);
                gradingUpdateInterval = null;
                return;
            }
            
            updateGradingTableContent();
        }, 2000);
    }
    
    function updateGradingTableContent() {
        const tbody = document.getElementById('grading-table-body');
        if (!tbody) return;
        
        const totalQuestions = CONTROL_STATE.quizData?.questions?.length || 0;
        
        // Recalculer les données
        const playersData = CONTROL_STATE.players.map(player => {
            let correctAnswers = 0;
            if (player.answers) {
                Object.values(player.answers).forEach(answer => {
                    if (answer.correct) correctAnswers++;
                });
            }
            
            const grade = totalQuestions > 0 ? ((correctAnswers / totalQuestions) * 20).toFixed(1) : '0.0';
            
            return {
                nickname: player.nickname,
                correctAnswers: correctAnswers,
                totalQuestions: totalQuestions,
                score: player.score || 0,
                grade: grade
            };
        });
        
        // Trier
        playersData.sort((a, b) => {
            if (b.correctAnswers !== a.correctAnswers) {
                return b.correctAnswers - a.correctAnswers;
            }
            return b.score - a.score;
        });
        
        // Mettre à jour le contenu avec classe clickable-row et data-nickname
        tbody.innerHTML = playersData.map((player, index) => `
            <tr class="clickable-row" data-nickname="${player.nickname.replace(/"/g, '&quot;')}">
                <td>${index + 1}</td>
                <td class="student-name">${player.nickname}</td>
                <td class="success-rate">
                    <span class="success-badge">${player.correctAnswers}/${player.totalQuestions}</span>
                    <span class="success-percent">${totalQuestions > 0 ? Math.round((player.correctAnswers / player.totalQuestions) * 100) : 0}%</span>
                </td>
                <td class="score-cell">${player.score} pts</td>
                <td class="grade-cell">
                    <span class="grade-value">${player.grade}</span>
                </td>
            </tr>
        `).join('');
        
        // Réattacher les event listeners
        tbody.querySelectorAll('.clickable-row').forEach(row => {
            row.addEventListener('click', function() {
                const nickname = this.getAttribute('data-nickname');
                if (nickname) {
                    window.showPlayerRecap(nickname);
                }
            });
        });
    }
    
    window.closeGradingTable = function(event) {
        if (event) event.stopPropagation();
        
        // Arrêter les mises à jour
        if (gradingUpdateInterval) {
            clearInterval(gradingUpdateInterval);
            gradingUpdateInterval = null;
        }
        
        const modal = document.getElementById('grading-modal');
        if (modal) modal.remove();
    };
    
    // ========================================
    // RÉCAPITULATIF D'UN JOUEUR
    // ========================================
    
    window.showPlayerRecap = function(nickname) {
        // Trouver le joueur
        const player = CONTROL_STATE.players.find(p => p.nickname === nickname);
        if (!player) {
            alert('Joueur introuvable');
            return;
        }
        
        const questions = CONTROL_STATE.quizData?.questions || [];
        const answers = player.answers || {};
        
        // Créer la modale de récapitulatif (similaire au récap élève)
        let html = `
            <div class="modal-overlay" onclick="closePlayerRecap()">
                <div class="modal-content recap-modal" onclick="event.stopPropagation()">
                    <div class="modal-header">
                        <h3>📊 Récapitulatif - ${nickname}</h3>
                        <button class="modal-close" onclick="closePlayerRecap()">✕</button>
                    </div>
                    
                    <div class="recap-content">
                        <div class="recap-summary">
                            <div class="recap-stat">
                                <strong>Score total :</strong> ${player.score || 0} points
                            </div>
                            <div class="recap-stat">
                                <strong>Questions répondues :</strong> ${Object.keys(answers).length} / ${questions.length}
                            </div>
                        </div>
        `;
        
        // Parcourir toutes les questions
        questions.forEach((q, index) => {
            const answer = answers[index];
            const isCorrect = answer ? (answer.correct || false) : false;
            const hasAnswered = answer !== undefined;
            
            html += `
                <div class="recap-question ${isCorrect ? 'correct' : (hasAnswered ? 'incorrect' : 'not-answered')}">
                    <div class="recap-question-number">Question ${index + 1}</div>
                    <div class="recap-question-text">${q.question}</div>
            `;
            
            if (!hasAnswered) {
                html += `<div class="recap-no-answer">❌ Non répondu</div>`;
            } else {
                // Parser la réponse si c'est une chaîne JSON
                let parsedAnswer = answer;
                if (answer.answer && typeof answer.answer === 'string') {
                    try {
                        const answerData = JSON.parse(answer.answer);
                        parsedAnswer = { ...answer, ...answerData };
                    } catch (e) {
                        console.error('Erreur parsing réponse:', e);
                    }
                }
                
                // Afficher la réponse de l'élève
                html += `<div class="recap-user-answer">`;
                
                if (isCorrect) {
                    html += `<div class="recap-answer-label correct-label">✅ Réponse (correcte) :</div>`;
                } else {
                    html += `<div class="recap-answer-label wrong-label">❌ Réponse :</div>`;
                }
                
                html += `<div class="recap-answer-value ${isCorrect ? 'correct-value' : 'wrong-value'}">`;
                html += formatAnswerForRecap(q, parsedAnswer);
                html += `</div></div>`;
                
                // Si incorrect, afficher la bonne réponse
                if (!isCorrect) {
                    html += `
                        <div class="recap-correct-answer">
                            <div class="recap-answer-label correct-label">✅ Bonne réponse :</div>
                            <div class="recap-answer-value correct-value">
                                ${formatCorrectAnswerForRecap(q)}
                            </div>
                        </div>
                    `;
                }
                
                // Afficher les points gagnés
                const points = answer.points || 0;
                if (points > 0) {
                    html += `<div class="recap-points">🎯 +${points} points</div>`;
                } else {
                    html += `<div class="recap-points">0 point</div>`;
                }
            }
            
            html += `</div>`;
        });
        
        html += `
                    </div>
                </div>
            </div>
        `;
        
        // Ajouter au body
        const modalDiv = document.createElement('div');
        modalDiv.id = 'player-recap-modal';
        modalDiv.innerHTML = html;
        document.body.appendChild(modalDiv);
    };
    
    window.closePlayerRecap = function() {
        const modal = document.getElementById('player-recap-modal');
        if (modal) modal.remove();
    };
    
    // Fonctions utilitaires pour formater les réponses
    function formatAnswerForRecap(question, answer) {
        switch(question.type) {
            case 'multiple':
            case 'truefalse':
                if (answer.index !== undefined && question.answers[answer.index]) {
                    return question.answers[answer.index].text;
                }
                return 'Réponse non valide';
            
            case 'order':
                if (Array.isArray(answer.order)) {
                    return answer.order.map((text, i) => 
                        `<div>${i + 1}. ${text}</div>`
                    ).join('');
                }
                return 'Réponse non valide';
            
            case 'freetext':
                if (answer.freetext) {
                    return answer.freetext;
                }
                return 'Réponse vide';
            
            default:
                return 'Type inconnu';
        }
    }
    
    function formatCorrectAnswerForRecap(question) {
        switch(question.type) {
            case 'multiple':
            case 'truefalse':
                const correctAnswer = question.answers.find(a => a.correct);
                if (correctAnswer) {
                    return correctAnswer.text;
                }
                return 'Non disponible';
            
            case 'order':
                // Trier par ordre
                const sortedAnswers = [...question.answers].sort((a, b) => a.order - b.order);
                return sortedAnswers.map((answer, i) => 
                    `<div>${i + 1}. ${answer.text}</div>`
                ).join('');
            
            case 'freetext':
                let result = question.answers[0].text;
                if (question.acceptedAnswers && question.acceptedAnswers.length > 0) {
                    result += '<br><small>(Variantes acceptées : ' + question.acceptedAnswers.join(', ') + ')</small>';
                }
                return result;
            
            default:
                return 'Non disponible';
        }
    }
    
    window.exportGradingCSV = function() {
        const totalQuestions = CONTROL_STATE.quizData?.questions?.length || 0;
        const questions = CONTROL_STATE.quizData?.questions || [];
        
        // En-tête CSV avec colonnes pour chaque question
        let csv = '#,Élève,Bonnes réponses,Total questions,Pourcentage,Score,Note /20';
        
        // Ajouter une colonne pour chaque question
        questions.forEach((q, index) => {
            csv += `,Q${index + 1} Réponse,Q${index + 1} Correct`;
        });
        csv += '\n';
        
        // Calculer les données
        const playersData = CONTROL_STATE.players.map(player => {
            let correctAnswers = 0;
            if (player.answers) {
                Object.values(player.answers).forEach(answer => {
                    if (answer.correct) correctAnswers++;
                });
            }
            
            const grade = totalQuestions > 0 ? ((correctAnswers / totalQuestions) * 20).toFixed(1) : '0.0';
            
            return {
                nickname: player.nickname,
                correctAnswers: correctAnswers,
                score: player.score || 0,
                grade: grade,
                answers: player.answers || {}
            };
        });
        
        // Trier
        playersData.sort((a, b) => {
            if (b.correctAnswers !== a.correctAnswers) {
                return b.correctAnswers - a.correctAnswers;
            }
            return b.score - a.score;
        });
        
        // Ajouter les données
        playersData.forEach((player, index) => {
            const percent = totalQuestions > 0 ? Math.round((player.correctAnswers / totalQuestions) * 100) : 0;
            csv += `${index + 1},"${player.nickname}",${player.correctAnswers},${totalQuestions},${percent}%,${player.score},${player.grade}`;
            
            // Ajouter la réponse pour chaque question
            questions.forEach((q, qIndex) => {
                const answer = player.answers[qIndex];
                let answerText = 'Non répondu';
                let isCorrect = 'Non';
                
                if (answer) {
                    isCorrect = answer.correct ? 'Oui' : 'Non';
                    
                    // Parser la réponse si nécessaire
                    let parsedAnswer = answer;
                    if (answer.answer && typeof answer.answer === 'string') {
                        try {
                            const answerData = JSON.parse(answer.answer);
                            parsedAnswer = { ...answer, ...answerData };
                        } catch (e) {
                            // Garder l'answer original
                        }
                    }
                    
                    // Formater la réponse selon le type
                    switch(q.type) {
                        case 'multiple':
                        case 'truefalse':
                            if (parsedAnswer.index !== undefined && q.answers[parsedAnswer.index]) {
                                answerText = q.answers[parsedAnswer.index].text;
                            }
                            break;
                        
                        case 'order':
                            if (Array.isArray(parsedAnswer.order)) {
                                answerText = parsedAnswer.order.join(' → ');
                            }
                            break;
                        
                        case 'freetext':
                            if (parsedAnswer.freetext) {
                                answerText = parsedAnswer.freetext;
                            }
                            break;
                    }
                }
                
                // Échapper les guillemets dans la réponse
                answerText = answerText.replace(/"/g, '""');
                csv += `,"${answerText}",${isCorrect}`;
            });
            
            csv += '\n';
        });
        
        // Télécharger
        const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `suivi_qwest_${new Date().toISOString().split('T')[0]}.csv`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
    };
    
    window.printGradingTable = function() {
        // Récupérer le contenu du tableau
        const table = document.getElementById('grading-table');
        if (!table) return;
        
        // Créer une fenêtre d'impression avec uniquement le tableau
        const printWindow = window.open('', '', 'height=600,width=800');
        printWindow.document.write('<html><head><title>Tableau de suivi - Qwest</title>');
        printWindow.document.write('<style>');
        printWindow.document.write(`
            body {
                font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
                padding: 20px;
            }
            h1 {
                text-align: center;
                color: #333;
                margin-bottom: 30px;
            }
            table {
                width: 100%;
                border-collapse: collapse;
                margin: 0 auto;
            }
            thead {
                background: #4F46E5;
                color: white;
            }
            th, td {
                padding: 12px;
                text-align: left;
                border-bottom: 1px solid #ddd;
            }
            th {
                font-weight: 700;
            }
            tbody tr:hover {
                background: #f5f5f5;
            }
            .success-badge {
                background: #E0E7FF;
                color: #4338CA;
                padding: 4px 8px;
                border-radius: 4px;
                font-weight: 700;
                font-size: 14px;
                margin-right: 8px;
            }
            .success-percent {
                color: #666;
                font-size: 14px;
            }
            .student-name {
                font-weight: 600;
            }
            .score-cell {
                font-weight: 700;
                color: #4F46E5;
            }
            .grade-value {
                font-weight: 700;
                font-size: 16px;
                color: #059669;
            }
            @media print {
                body {
                    padding: 0;
                }
            }
        `);
        printWindow.document.write('</style></head><body>');
        printWindow.document.write('<h1>📊 Tableau de suivi complet - Qwest</h1>');
        printWindow.document.write(table.outerHTML);
        printWindow.document.write('</body></html>');
        printWindow.document.close();
        printWindow.focus();
        
        // Attendre que la page soit chargée puis imprimer
        setTimeout(() => {
            printWindow.print();
            printWindow.close();
        }, 250);
    };

    // ========================================
    // POLLING PROF (remplace SSE)
    // ========================================
    
    let controlPollingInterval = null;
    let lastControlState = null;
    let lastResultsQuestionIndex = -1;
    
    function startControlPolling() {
        console.log('🔄 PROF: Démarrage du polling (1 requête/seconde)');
        
        // Arrêter le polling existant si présent
        if (controlPollingInterval) {
            clearInterval(controlPollingInterval);
        }
        
        const poll = async () => {
            if (!CONTROL_STATE.playCode) {
                return;
            }
            
            try {
                const response = await fetch(`php/control.php?action=get_control_state&playCode=${CONTROL_STATE.playCode}`);
                const data = await response.json();
                
                if (!data.success) {
                    console.error('❌ PROF: Erreur polling:', data.message);
                    return;
                }
                
                // Mise à jour de la liste des joueurs
                if (data.players) {
                    updateControlPlayersList(data.players);
                }
                
                // Détecter si des résultats sont disponibles
                if (data.resultsAvailable && data.questionIndex !== lastResultsQuestionIndex) {
                    console.log('🟢 PROF: Résultats reçus pour question', data.questionIndex);
                    lastResultsQuestionIndex = data.questionIndex;
                    
                    // En mode automatique, passer à la question suivante après 10 secondes
                    if (!CONTROL_STATE.manualMode) {
                        console.log('⏰ PROF: Passage auto à la question suivante dans 10s');
                        
                        CONTROL_STATE.autoNextTimestamp = Date.now() + 10000;
                        CONTROL_STATE.autoNextQuestionPending = true;
                        
                        if (!CONTROL_STATE.autoNextCheckInterval) {
                            CONTROL_STATE.autoNextCheckInterval = setInterval(() => {
                                if (CONTROL_STATE.autoNextQuestionPending && 
                                    !CONTROL_STATE.isPaused && 
                                    Date.now() >= CONTROL_STATE.autoNextTimestamp) {
                                    
                                    CONTROL_STATE.autoNextQuestionPending = false;
                                    console.log('⏰ PROF: Lancement auto de la question suivante');
                                    nextQuestion();
                                }
                            }, 500);
                        }
                    }
                }
                
            } catch (error) {
                console.error('❌ PROF: Erreur polling:', error);
            }
        };
        
        // Première requête immédiate
        poll();
        
        // Puis toutes les secondes
        controlPollingInterval = setInterval(poll, 1000);
    }
    
    // ========================================
    // RESYNCHRONISATION D'URGENCE
    // ========================================
    
    window.forceResync = async function() {
        if (!confirm('🔄 Forcer la resynchronisation ?\n\nCela va forcer l\'affichage des résultats actuels pour tous les élèves.\nUtilisez ceci uniquement si les élèves sont bloqués.')) {
            return;
        }
        
        try {
            // Marquer la question actuelle comme complétée
            const response = await fetch('php/control.php', {
                method: 'POST',
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                body: new URLSearchParams({
                    action: 'force_question_complete',
                    playCode: CONTROL_STATE.playCode,
                    questionIndex: CONTROL_STATE.currentQuestion
                })
            });
            
            const result = await response.json();
            
            if (result.success) {
                console.log('✅ Resynchronisation forcée avec succès');
                alert('✅ Resynchronisation effectuée !\nLes élèves devraient maintenant voir les résultats.');
            } else {
                alert('❌ Erreur lors de la resynchronisation');
            }
            
        } catch (error) {
            console.error('❌ Erreur resynchronisation:', error);
            alert('❌ Erreur lors de la resynchronisation');
        }
    };

    // ========================================
    // MODE PROJECTION
    // ========================================
    
    let projectionWindow = null;
    let projectionUpdateInterval = null;
    let teacherWindow = null;
    
    function openProjectionMode() {
        // Créer l'URL avec les paramètres - utiliser les questions de la session en cours
        const totalQuestions = CONTROL_STATE.quizData?.questions.length || APP_STATE.questions.length;
        const projectionURL = 'projection.html?code=' + CONTROL_STATE.playCode + '&total=' + totalQuestions;
        
        // Ouvrir dans un nouvel onglet
        projectionWindow = window.open(projectionURL, '_blank');
        
        if (!projectionWindow) {
            alert('❌ Impossible d\'ouvrir la projection. Vérifiez que les popups ne sont pas bloquées.');
            return;
        }
        
        console.log('📽️ PROJECTION: Fenêtre ouverte, démarrage des mises à jour...');
        
        // Attendre que le document soit chargé avant de démarrer
        setTimeout(() => {
            startProjectionUpdates();
            
            // Première mise à jour immédiate
            setTimeout(() => {
                console.log('📽️ PROJECTION: Première mise à jour...');
                updateProjectionWindow();
            }, 100);
        }, 1000);
        
        // Gérer la fermeture
        const checkClosed = setInterval(() => {
            if (projectionWindow.closed) {
                clearInterval(checkClosed);
                stopProjectionUpdates();
            }
        }, 1000);
    }
    
    function startProjectionUpdates() {
        console.log('📽️ PROJECTION: Démarrage du polling (toutes les 500ms)');
        projectionUpdateInterval = setInterval(() => {
            updateProjectionWindow();
        }, 500);
    }
    
    function stopProjectionUpdates() {
        if (projectionUpdateInterval) {
            clearInterval(projectionUpdateInterval);
            projectionUpdateInterval = null;
        }
    }
    
    function updateProjectionWindow() {
        // Arrêter seulement si TOUTES les fenêtres sont fermées
        const projectionClosed = !projectionWindow || projectionWindow.closed;
        const teacherClosed = !teacherWindow || teacherWindow.closed;
        
        if (projectionClosed && teacherClosed) {
            stopProjectionUpdates();
            return;
        }
        
        // Récupérer l'état du jeu via le serveur
        fetch('php/control.php?action=get_control_state&playCode=' + CONTROL_STATE.playCode)
            .then(res => res.json())
            .then(result => {
                if (!result.success) {
                    console.error('❌ PROJECTION: Erreur API', result);
                    return;
                }
                
                console.log('📽️ PROJECTION: État reçu', result);
                
                // Préparer les données de base - utiliser les questions de la session en cours
                const data = {
                    playCode: CONTROL_STATE.playCode,
                    state: result.state,
                    currentQuestion: result.currentQuestion,
                    playersCount: result.players.length,
                    participants: result.players,
                    manualMode: CONTROL_STATE.manualMode,
                    paused: result.paused || false,
                    screen: 'waiting',
                    questions: CONTROL_STATE.quizData?.questions || APP_STATE.questions
                };
                
                // Détecter l'écran actuel selon l'état du serveur
                if (result.state === 'ended') {
                    console.log('📽️ PROJECTION: Affichage écran final');
                    data.screen = 'final';
                } else if (result.state === 'showing_top3' || result.state === 'showing_results') {
                    console.log('📽️ PROJECTION: Affichage top3');
                    data.screen = 'top3';
                    // Trier les joueurs par score
                    const sortedPlayers = result.players.slice().sort((a, b) => b.score - a.score);
                    data.top3 = sortedPlayers.slice(0, 3);
                } else if (result.state === 'playing' && result.currentQuestion >= 0) {
                    console.log('📽️ PROJECTION: Affichage question', result.currentQuestion);
                    data.screen = 'question';
                } else {
                    console.log('📽️ PROJECTION: En attente');
                }
                
                // Envoyer à la fenêtre de projection si ouverte
                if (projectionWindow && !projectionWindow.closed && projectionWindow.updateProjection) {
                    projectionWindow.updateProjection(data);
                } else if (!projectionClosed) {
                    console.warn('⚠️ PROJECTION: updateProjection non disponible');
                }
                
                // Envoyer aussi à la fenêtre teacher si ouverte
                console.log('👨‍🏫 DEBUG: teacherWindow =', teacherWindow);
                console.log('👨‍🏫 DEBUG: teacherWindow.closed =', teacherWindow ? teacherWindow.closed : 'N/A');
                console.log('👨‍🏫 DEBUG: teacherWindow.updateTeacher =', teacherWindow ? teacherWindow.updateTeacher : 'N/A');
                
                if (teacherWindow && !teacherWindow.closed && teacherWindow.updateTeacher) {
                    console.log('👨‍🏫 CONTROL: Appel de teacherWindow.updateTeacher()');
                    teacherWindow.updateTeacher(data);
                } else {
                    console.log('👨‍🏫 CONTROL: teacherWindow non disponible');
                }
            })
            .catch(err => {
                console.error('❌ PROJECTION: Erreur mise à jour:', err);
            });
    }
    
    // ========================================
    // APERÇU DE LA QUESTION EN COURS
    // ========================================
    
    function toggleQuestionPreview() {
        const existingPreview = document.getElementById('question-preview-overlay');
        
        if (existingPreview) {
            closeQuestionPreview();
            return;
        }
        
        // Récupérer la question actuelle
        const currentQuestionIndex = CONTROL_STATE.currentQuestion;
        if (currentQuestionIndex < 0 || !CONTROL_STATE.quizData?.questions) {
            return;
        }
        
        const question = CONTROL_STATE.quizData.questions[currentQuestionIndex];
        if (!question) return;
        
        // Créer l'overlay d'aperçu
        const overlay = document.createElement('div');
        overlay.id = 'question-preview-overlay';
        overlay.className = 'question-preview-overlay';
        overlay.onclick = closeQuestionPreview;
        
        // Générer le contenu selon le type de question
        let answersHTML = '';
        
        switch(question.type) {
            case 'multiple':
            case 'truefalse':
                answersHTML = '<div class="preview-answers">';
                question.answers.forEach((answer, index) => {
                    const correctClass = answer.correct ? 'preview-correct' : '';
                    answersHTML += `
                        <div class="preview-answer ${correctClass}">
                            <span class="preview-answer-label">${String.fromCharCode(65 + index)}</span>
                            <span class="preview-answer-text">${answer.text}</span>
                            ${answer.correct ? '<span class="preview-check">✓</span>' : ''}
                        </div>
                    `;
                });
                answersHTML += '</div>';
                break;
                
            case 'order':
                answersHTML = '<div class="preview-answers preview-order">';
                answersHTML += '<p class="preview-instruction">Ordre correct :</p>';
                question.answers
                    .sort((a, b) => a.order - b.order)
                    .forEach((answer, index) => {
                        answersHTML += `
                            <div class="preview-order-item">
                                <span class="preview-order-num">${index + 1}.</span>
                                <span>${answer.text}</span>
                            </div>
                        `;
                    });
                answersHTML += '</div>';
                break;
                
            case 'freetext':
                answersHTML = '<div class="preview-answers preview-freetext">';
                answersHTML += '<p class="preview-instruction">Réponses acceptées :</p>';
                answersHTML += `<div class="preview-freetext-main">✓ ${question.answers[0].text}</div>`;
                if (question.acceptedAnswers && question.acceptedAnswers.length > 0) {
                    question.acceptedAnswers.forEach(variant => {
                        answersHTML += `<div class="preview-freetext-variant">✓ ${variant}</div>`;
                    });
                }
                answersHTML += `<p class="preview-case-info">${question.caseSensitive ? '⚠️ Sensible à la casse' : 'ℹ️ Insensible à la casse'}</p>`;
                answersHTML += '</div>';
                break;
        }
        
        overlay.innerHTML = `
            <div class="question-preview-card" onclick="event.stopPropagation()">
                <div class="preview-header">
                    <h3>👁️ Aperçu de la question ${currentQuestionIndex + 1}</h3>
                    <button class="preview-close" onclick="closeQuestionPreview()">×</button>
                </div>
                <div class="preview-body">
                    ${question.imageUrl ? `
                        <div class="preview-image">
                            <img src="${question.imageUrl}" alt="Image de la question">
                        </div>
                    ` : ''}
                    <div class="preview-question">
                        ${question.question}
                    </div>
                    ${answersHTML}
                    <div class="preview-meta">
                        <span class="preview-time">⏱️ ${question.time}s</span>
                        <span class="preview-type">${getQuestionTypeLabel(question.type)}</span>
                    </div>
                </div>
            </div>
        `;
        
        document.body.appendChild(overlay);
        
        // Animation d'entrée
        setTimeout(() => {
            overlay.classList.add('active');
        }, 10);
    }
    
    function closeQuestionPreview() {
        const overlay = document.getElementById('question-preview-overlay');
        if (overlay) {
            overlay.classList.remove('active');
            setTimeout(() => {
                overlay.remove();
            }, 300);
        }
    }
    
    function getQuestionTypeLabel(type) {
        const labels = {
            'multiple': '☑️ Choix multiple',
            'truefalse': '✓✗ Vrai/Faux',
            'order': '🔢 Ordre',
            'freetext': '✍️ Réponse libre'
        };
        return labels[type] || type;
    }

    // ========================================
    // EXPORT VERS GLOBAL
    // ========================================
    
    window.openControlPanel = openControlPanel;
    window.openTeacherPlay = openTeacherPlay;
    window.closeControlPanel = closeControlPanel;
    window.startGame = startGame;
    window.pauseGame = pauseGame;
    window.nextQuestion = nextQuestion;
    window.endGame = endGame;
    window.refreshPlayers = refreshPlayers;
    window.showFullScoreboard = showFullScoreboard;
    window.showGradingTable = showGradingTable;
    window.toggleManualMode = toggleManualMode;
    window.toggleShowTop3 = toggleShowTop3;
    window.toggleQuestionPreview = toggleQuestionPreview;
    window.closeQuestionPreview = closeQuestionPreview;
    window.openProjectionMode = openProjectionMode;

})();
