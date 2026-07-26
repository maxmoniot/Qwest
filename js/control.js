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
        autoNextCheckInterval: null,
        // Anti lost-update (hébergement mutualisé) : dernière avance CONFIRMÉE par le
        // serveur, et horodatage de la dernière commande envoyée. Permet au polling de
        // détecter qu'une écriture next_question a été engloutie par une écriture
        // concurrente (l'état serveur « recule ») et de la ré-émettre automatiquement.
        lastCommandedQuestion: null,
        lastCommandTs: 0,
        _nextInFlight: false,
        _pausePending: false
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
        CONTROL_STATE.isPaused = false;
        // Purge complète de l'état de conduite (lastCommandedQuestion, repairState,
        // auto-next…) pour qu'une partie suivante reparte propre (cf. resetConductorState).
        resetConductorState();
        
        // Arrêter le polling immédiatement (setTimeout adaptatif)
        if (controlPollingInterval) {
            console.log('🔴 PROF: Arrêt du polling...');
            clearTimeout(controlPollingInterval);
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
                            playCode: playCodeToCleanup,
                            teacher_hash: window.CONFIG?.TEACHER_PASSWORD_HASH || ''
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
                            playCode: playCodeToCleanup,
                            teacher_hash: window.CONFIG?.TEACHER_PASSWORD_HASH || ''
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
                    showTop3: CONTROL_STATE.showTop3 ? '1' : '0',
                    teacher_hash: window.CONFIG?.TEACHER_PASSWORD_HASH || ''
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
            <div class="code-info" onclick="copyToClipboard('${CONTROL_STATE.playCode}', this)" style="cursor: pointer; padding: var(--space-sm); border-radius: var(--radius-md); transition: background-color 0.3s;" title="Cliquer pour copier">
                <span class="code-label">Code :</span>
                <span class="code-value">${CONTROL_STATE.playCode}</span>
            </div>
            <div class="qr-btn" onclick="showQrModal()" title="Afficher le QR code">
                <span class="qr-icon">⬛</span>
                <span class="qr-btn-label">QR</span>
            </div>
        `;

        // Générer le QR code miniature
        requestAnimationFrame(() => generateQrMini(CONTROL_STATE.playCode));
        
        panel.innerHTML = `
            <div class="control-interface">
                <!-- Options de jeu -->
                <div class="control-section collapsible collapsed">
                    <h4 class="section-title" onclick="toggleSection(this)">
                        <span class="collapse-icon">▶</span>
                        ⚙️ Options de jeu
                    </h4>
                    <div class="section-content">
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
                </div>
                
                <!-- Participants -->
                <div class="control-section collapsible collapsed">
                    <div class="section-header">
                        <h4 class="section-title" onclick="toggleSection(this)">
                            <span class="collapse-icon">▶</span>
                            👥 Participants connectés : <span id="control-player-count">0</span>
                        </h4>
                        <!-- Boutons visibles en desktop même si replié -->
                        <div class="section-header-buttons section-header-buttons-desktop">
                            <button class="btn-small" onclick="refreshPlayers()">🔄 Actualiser</button>
                            <button id="btn-resync" class="btn-small" onclick="forceResync()" disabled title="Force les élèves à se resynchroniser en cas de blocage">
                                🔄 Resynchroniser
                            </button>
                        </div>
                    </div>
                    <div class="section-content">
                        <!-- Boutons visibles en mobile seulement si déplié -->
                        <div class="section-header-buttons section-header-buttons-mobile">
                            <button class="btn-small" onclick="refreshPlayers()">🔄 Actualiser</button>
                            <button id="btn-resync-mobile" class="btn-small" onclick="forceResync()" disabled title="Force les élèves à se resynchroniser en cas de blocage">
                                🔄 Resynchroniser
                            </button>
                        </div>
                        <div id="control-players-list" class="control-players-list">
                            <div class="empty-list">Aucun joueur pour le moment</div>
                        </div>
                    </div>
                </div>
                
                <!-- Contrôles -->
                <div class="control-section collapsible">
                    <div class="section-header">
                        <h4 class="section-title" onclick="toggleSection(this)">
                            <span class="collapse-icon">▶</span>
                            🎛️ Contrôles
                        </h4>
                        <button id="btn-projection" class="btn-small btn-projection" onclick="openProjectionMode()" disabled title="Mode projection pour afficher aux élèves">
                            📽️ Projection
                        </button>
                    </div>
                    <div class="section-content">
                        <div class="control-buttons">
                            <button id="btn-start-game" class="btn-control btn-success" onclick="startGame()">
                                ▶️ Lancer la partie
                            </button>
                            <button id="btn-end-game" class="btn-control btn-danger" onclick="endGame()" disabled>
                                ⏹️ Terminer
                            </button>
                            <button id="btn-next-question" class="btn-control btn-primary" onclick="nextQuestion()" disabled>
                                <span class="btn-text-desktop">⏭️ Question suivante</span>
                                <span class="btn-text-mobile">⏭️ Suivante</span>
                            </button>
                            <button id="btn-pause-game" class="btn-control btn-warning" onclick="pauseGame()" disabled>
                                ⏸️ Pause
                            </button>
                            <button class="btn-control btn-info" onclick="showGradingTable()">
                                📊 Tableau de suivi complet
                            </button>
                        </div>
                    </div>
                </div>
                
                <!-- Progress -->
                <div class="control-section collapsible">
                    <div class="section-header">
                        <h4 class="section-title" onclick="toggleSection(this)">
                            <span class="collapse-icon">▶</span>
                            📊 Progression
                        </h4>
                        <button id="btn-preview-question" class="btn-small btn-preview" onclick="toggleQuestionPreview()" disabled title="Aperçu de la question en cours">
                            👁️ Aperçu question en cours
                        </button>
                    </div>
                    <div class="section-content">
                        <div class="question-progress-bar">
                            <div class="progress-fill" id="question-progress" style="width: 0%"></div>
                        </div>
                        <p class="progress-text">
                            Question <span id="current-q-num">0</span> / <span id="total-q-num">${APP_STATE.questions.length}</span>
                        </p>
                    </div>
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
    
    function toggleSection(titleElement) {
        const section = titleElement.closest('.control-section');
        section.classList.toggle('collapsed');
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
            
            // Bouton de resync TOUJOURS VISIBLE
            // Plus visible (warning) si l'élève est déconnecté
            const resyncButtonClass = !player.connected ? 'btn-warning' : 'btn-secondary';
            const resyncButton = `<button class="btn-icon ${resyncButtonClass}" onclick="reconnectPlayer('${player.nickname}')" title="Resynchroniser cet élève">
                    🔄
                </button>`;

            // Anti-triche : marqueur si l'élève a quitté l'onglet pendant une question.
            const tabSwitches = player.tabSwitchCount || 0;
            const tabWarn = tabSwitches > 0
                ? `<span class="player-tabwarn" title="A quitté l'onglet ${tabSwitches} fois pendant la partie" style="color:#e65100;font-weight:700;margin-left:6px;">⚠️${tabSwitches}</span>`
                : '';

            html += `
                <div class="control-player-item ${statusClass}">
                    <span class="player-status">${statusIcon}</span>
                    <span class="player-nick">${escapeHtml(player.nickname)}${tabWarn}</span>
                    <span class="player-progress">✓ ${correctAnswers}/${totalQuestions}</span>
                    <span class="player-score" id="score-${index}">${player.score || 0} pts</span>
                    <div class="player-actions">
                        ${resyncButton}
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
                            score: newScore,
                            teacher_hash: window.CONFIG?.TEACHER_PASSWORD_HASH || ''
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
    
    /**
     * Resynchroniser un joueur déconnecté individuellement
     */
    async function reconnectPlayer(nickname) {
        console.log('🔄 PROF: Tentative de resynchronisation de', nickname);
        
        try {
            const response = await fetch('php/game.php', {
                method: 'POST',
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                body: new URLSearchParams({
                    action: 'reconnect_player',
                    playCode: CONTROL_STATE.playCode,
                    nickname: nickname
                })
            });
            
            const result = await response.json();
            
            if (result.success && result.online) {
                // L'élève est vraiment en ligne
                console.log('✅ PROF: Joueur en ligne et resynchronisé');
                showCustomAlert(
                    'Resynchronisation réussie', 
                    `${nickname} est en ligne et a été resynchronisé avec succès.`, 
                    '✅'
                );
            } else if (!result.online) {
                // L'élève est hors ligne
                console.warn('⚠️ PROF: Joueur hors ligne');
                const timeSince = result.timeSinceLastPing || 'inconnu';
                showCustomAlert(
                    'Élève hors ligne', 
                    `${nickname} ne répond pas (hors ligne depuis ${timeSince}s).\n\nDemandez-lui de :\n• Vérifier sa connexion WiFi\n• Rafraîchir la page (F5)`, 
                    '⚠️'
                );
            } else {
                console.error('❌ PROF: Échec resynchronisation:', result.message);
                showCustomAlert('Échec', 'Impossible de resynchroniser le joueur. Réessayez ou utilisez le bouton de resynchronisation globale.', '❌');
            }
        } catch (error) {
            console.error('❌ PROF: Erreur resynchronisation:', error);
            showCustomAlert('Erreur', 'Erreur de connexion au serveur.', '❌');
        }
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
                            nickname: nickname,
                            teacher_hash: window.CONFIG?.TEACHER_PASSWORD_HASH || ''
                        })
                    });
                    
                    const result = await response.json();
                    if (result.success) {
                        console.log('✅ PROF: Joueur supprimé');
                        pushInstantSync();
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
    window.reconnectPlayer = reconnectPlayer;

    // ========================================
    // ACTIONS DE CONTRÔLE
    // ========================================

    /**
     * Pousse une resync immédiate vers les fenêtres prof secondaires (teacher-play, projection),
     * de manière à court-circuiter leur cycle de polling après une action prof.
     * - teacher-play : appelle window.forceSyncGameState (exposé par sessionManager.js)
     *   qui fait un get_state immédiat et applique la nouvelle question / les résultats.
     * - projection   : déclenche updateProjectionWindow (défini plus bas dans ce module)
     *   qui interroge get_control_state et envoie les données à la fenêtre projection.
     * Tolérant : si une fenêtre est fermée ou pas prête, on ignore silencieusement.
     */
    function pushInstantSync() {
        try {
            if (typeof teacherWindow !== 'undefined' && teacherWindow && !teacherWindow.closed) {
                if (typeof teacherWindow.forceSyncGameState === 'function') {
                    teacherWindow.forceSyncGameState();
                }
            }
        } catch (e) { /* fenêtre fermée ou cross-origin — on ignore */ }
        try {
            if (typeof updateProjectionWindow === 'function') {
                updateProjectionWindow();
            }
        } catch (e) { /* idem */ }
    }

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
            // CRITIQUE : repartir d'un état de conduite VIERGE. Sinon, en enchaînant une
            // nouvelle partie sans recharger la fenêtre, lastCommandedQuestion (etc.) de la
            // partie précédente fait sauter celle-ci à la fin (cf. resetConductorState).
            resetConductorState();

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
                    // 1. D'abord, dédupliquer les questions basé sur leur texte
                    const seenQuestions = new Set();
                    const uniqueQuestions = APP_STATE.questions.filter(q => {
                        const key = q.question.trim().toLowerCase();
                        if (seenQuestions.has(key)) {
                            console.log(`🎲 PROF: Question en doublon ignorée: "${q.question.substring(0, 30)}..."`);
                            return false;
                        }
                        seenQuestions.add(key);
                        return true;
                    });
                    
                    if (uniqueQuestions.length < APP_STATE.questions.length) {
                        console.log(`🎲 PROF: ${APP_STATE.questions.length - uniqueQuestions.length} doublon(s) supprimé(s)`);
                    }
                    
                    // 2. Copier le tableau pour ne pas modifier l'original
                    const shuffled = [...uniqueQuestions];
                    
                    // 3. Algorithme de Fisher-Yates pour un vrai mélange aléatoire
                    // (plus fiable que sort(() => Math.random() - 0.5))
                    for (let i = shuffled.length - 1; i > 0; i--) {
                        const j = Math.floor(Math.random() * (i + 1));
                        [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
                    }
                    
                    // 4. Prendre les N premières questions
                    const actualLimit = Math.min(limit, shuffled.length);
                    questionsToUse = shuffled.slice(0, actualLimit);
                    console.log(`🎲 PROF: ${actualLimit} questions sélectionnées aléatoirement sur ${uniqueQuestions.length} uniques`);
                    console.log(`🎲 PROF: Questions sélectionnées : ${questionsToUse.map(q => q.question.substring(0, 25) + '...').join(', ')}`);
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
                    quizData: JSON.stringify(CONTROL_STATE.quizData),
                    teacher_hash: window.CONFIG?.TEACHER_PASSWORD_HASH || ''
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
                    showTop3: CONTROL_STATE.showTop3 ? '1' : '0',
                    teacher_hash: window.CONFIG?.TEACHER_PASSWORD_HASH || ''
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
                
                // Activer les boutons de resynchronisation (desktop et mobile)
                const btnResync = document.getElementById('btn-resync');
                const btnResyncMobile = document.getElementById('btn-resync-mobile');
                if (btnResync) btnResync.disabled = false;
                if (btnResyncMobile) btnResyncMobile.disabled = false;
                
                // Désactiver les options
                if (checkManual) checkManual.disabled = true;
                if (checkTop3) checkTop3.disabled = true;
                if (checkCustomTime) checkCustomTime.disabled = true;
                if (checkLimitQuestions) checkLimitQuestions.disabled = true;
                if (inputLimitQuestions) inputLimitQuestions.disabled = true;
                if (inputCustomTime) inputCustomTime.disabled = true;
                
                // Push immédiat aux fenêtres prof secondaires (teacher-play, projection)
                // pour qu'elles voient le passage en 'playing' sans attendre leur prochain poll.
                pushInstantSync();

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
        // Anti double-toggle : un seul basculement à la fois (les logs montraient des
        // paires pause/reprise à 1 s d'intervalle quand le bouton était re-cliqué avant
        // la confirmation serveur). Pendant l'envoi, la réconciliation du poll est aussi
        // suspendue via ce flag pour ne pas écraser l'intention du prof.
        if (CONTROL_STATE._pausePending) return;
        CONTROL_STATE._pausePending = true;

        const newPaused = !CONTROL_STATE.isPaused;
        const restore = lockButton('btn-pause-game', '⏳…');

        try {
            const result = await controlRequest('pause_game', {
                playCode: CONTROL_STATE.playCode,
                paused: newPaused ? '1' : '0'
            });

            if (result.ok) {
                CONTROL_STATE.isPaused = newPaused;
                const btn = document.getElementById('btn-pause-game');
                if (btn) btn.innerHTML = newPaused ? '▶️ Reprendre' : '⏸️ Pause';
                if (btn) btn.disabled = false;
                pushInstantSync();
            } else {
                console.error('❌ PROF: pauseGame a échoué', result.error || result.data);
                restore();
                showToast('Pause/Reprendre non confirmée. Réessaye dans un instant.', 'warning', 4000);
            }
        } finally {
            CONTROL_STATE._pausePending = false;
        }
    }

    /**
     * Helper de requête côté pilote avec retry exponentiel.
     * Tentatives : immédiate, +500ms, +1500ms, +4000ms (4 essais max).
     * Timeout par tentative : 8 s. Renvoie { ok, data, error }.
     *
     * Toutes les actions de pilotage doivent passer par ce helper et être idempotentes
     * côté serveur, pour que les retries soient sûrs en cas de timeout / 5xx.
     *
     * Auth prof : on injecte automatiquement teacher_hash dans le body. Le serveur
     * vérifie ce hash sur toutes les actions sensibles (cf. control.php $privilegedActions).
     */
    // ========================================
    // CIRCUIT BREAKER côté prof
    // ========================================
    // Même logique que côté élève (sessionManager.js) : sur 4xx/5xx/timeout en
    // rafale, on impose une pause pour ne pas amplifier un ban de l'hébergeur.
    // Respecte strictement l'en-tête Retry-After. Toast non bloquant pour le prof.
    const PROF_CB_THRESHOLD = (window.CONFIG && window.CONFIG.CIRCUIT_BREAKER_THRESHOLD) || 3;
    const PROF_CB_WINDOW_MS = (window.CONFIG && window.CONFIG.CIRCUIT_BREAKER_WINDOW_MS) || 30000;
    const PROF_CB_PAUSES = (window.CONFIG && window.CONFIG.CIRCUIT_BREAKER_PAUSES) || [60000, 120000, 300000];
    const PROF_CB_MAX_RA = (window.CONFIG && window.CONFIG.CIRCUIT_BREAKER_MAX_RETRY_AFTER_MS) || 600000;
    let profCbErrors = [];
    let profCbLevel = 0;
    let profCbPausedUntil = 0;

    function profParseRetryAfterMs(response) {
        try {
            if (!response || !response.headers) return 0;
            const v = response.headers.get('Retry-After');
            if (!v) return 0;
            const n = parseFloat(v);
            if (!Number.isNaN(n) && n >= 0) {
                return Math.min(PROF_CB_MAX_RA, Math.round(n * 1000));
            }
            const t = Date.parse(v);
            if (!Number.isNaN(t)) {
                return Math.min(PROF_CB_MAX_RA, Math.max(0, t - Date.now()));
            }
        } catch (e) {}
        return 0;
    }

    function profRecordError(retryAfterMs) {
        const now = Date.now();
        profCbErrors.push(now);
        profCbErrors = profCbErrors.filter(t => (now - t) <= PROF_CB_WINDOW_MS);

        let pausedFor = 0;
        if (retryAfterMs > 0) {
            profCbPausedUntil = Math.max(profCbPausedUntil, now + retryAfterMs);
            profCbLevel = Math.min(profCbLevel + 1, PROF_CB_PAUSES.length - 1);
            profCbErrors = [];
            pausedFor = retryAfterMs;
            console.warn('🔌 PROF CB: pause imposée par serveur', Math.round(retryAfterMs / 1000), 's');
        } else if (profCbErrors.length >= PROF_CB_THRESHOLD) {
            const idx = Math.min(profCbLevel, PROF_CB_PAUSES.length - 1);
            const pauseMs = PROF_CB_PAUSES[idx];
            profCbPausedUntil = Math.max(profCbPausedUntil, now + pauseMs);
            profCbLevel = Math.min(profCbLevel + 1, PROF_CB_PAUSES.length - 1);
            profCbErrors = [];
            pausedFor = pauseMs;
            console.warn('🔌 PROF CB: seuil atteint, pause', Math.round(pauseMs / 1000), 's (palier', profCbLevel, ')');
        }
        if (pausedFor > 0 && typeof showToast === 'function') {
            const sec = Math.ceil(pausedFor / 1000);
            const label = sec >= 60 ? `${Math.floor(sec / 60)} min ${sec % 60}s` : `${sec}s`;
            showToast(`🔌 Connexion lente, pause ${label}`, 'warning', 6000);
        }
    }

    function profResetCircuit() {
        if (profCbErrors.length === 0 && profCbPausedUntil === 0 && profCbLevel === 0) return;
        profCbErrors = [];
        profCbPausedUntil = 0;
        profCbLevel = 0;
    }

    function profIsCircuitPaused() {
        return Date.now() < profCbPausedUntil;
    }

    function profTimeUntilReopens() {
        return Math.max(0, profCbPausedUntil - Date.now());
    }

    // Exposer pour le polling adaptatif
    window.__profCircuit = { isPaused: profIsCircuitPaused, untilReopens: profTimeUntilReopens };

    async function controlRequest(action, params, opts = {}) {
        const maxAttempts = opts.maxAttempts ?? 4;
        const delays = [0, 500, 1500, 4000];
        const timeoutMs = opts.timeoutMs ?? 8000;
        let lastError = null;

        // Injection automatique du hash prof (cf. config.js TEACHER_PASSWORD_HASH).
        const authParams = { ...params };
        if (window.CONFIG && window.CONFIG.TEACHER_PASSWORD_HASH && !authParams.teacher_hash) {
            authParams.teacher_hash = window.CONFIG.TEACHER_PASSWORD_HASH;
        }

        // Si le circuit breaker est ouvert : on n'essaye pas du tout. Renvoie
        // immédiatement un échec — l'action sera idempotente côté serveur si
        // l'utilisateur retente après la pause.
        if (profIsCircuitPaused()) {
            const wait = profTimeUntilReopens();
            console.warn(`🔌 PROF: ${action} bloqué par CB (reprise dans ${Math.ceil(wait / 1000)}s)`);
            return { ok: false, error: new Error('circuit_breaker_open'), circuitOpen: true, retryAfterMs: wait };
        }

        for (let attempt = 0; attempt < maxAttempts; attempt++) {
            if (profIsCircuitPaused()) {
                console.warn(`🔌 PROF: ${action} interrompu (CB ouvert pendant retries)`);
                return { ok: false, error: lastError || new Error('circuit_breaker_open'), circuitOpen: true };
            }
            if (delays[attempt]) {
                await new Promise(r => setTimeout(r, delays[attempt]));
            }
            const controller = new AbortController();
            const t = setTimeout(() => controller.abort(), timeoutMs);
            try {
                const response = await fetch('php/control.php', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                    body: new URLSearchParams({ action, ...authParams }),
                    signal: controller.signal
                });
                clearTimeout(t);
                if (!response.ok) {
                    const retryAfterMs = profParseRetryAfterMs(response);
                    lastError = new Error('HTTP ' + response.status);
                    console.warn(`⚠️ PROF: ${action} HTTP ${response.status} (tentative ${attempt + 1})`);
                    profRecordError(retryAfterMs);
                    if (profIsCircuitPaused()) {
                        return { ok: false, error: lastError, circuitOpen: true };
                    }
                    continue;
                }
                const data = await response.json();
                if (data && data.success) {
                    profResetCircuit();
                    return { ok: true, data };
                }
                // Échec applicatif non-retryable (mismatch question, session perdue, etc.)
                // → PAS une erreur réseau, on ne déclenche pas le CB
                console.warn(`⛔ PROF: ${action} refusé par serveur (tentative ${attempt + 1})`, data);
                return { ok: false, data };
            } catch (err) {
                clearTimeout(t);
                lastError = err;
                console.warn(`⚠️ PROF: ${action} erreur réseau (tentative ${attempt + 1}):`, err.message || err);
                profRecordError(0);
                if (profIsCircuitPaused()) {
                    return { ok: false, error: lastError, circuitOpen: true };
                }
            }
        }
        return { ok: false, error: lastError };
    }

    /**
     * Toast non-bloquant — pour les notifications qui ne doivent pas interrompre le prof
     * pendant la partie. Apparaît en haut à droite, disparaît tout seul après quelques secondes.
     * Utilisé à la place de alert() pour les échecs réseau qui se résolvent souvent au polling suivant.
     */
    function showToast(message, kind = 'info', durationMs = 5000) {
        let container = document.getElementById('qwest-toast-container');
        if (!container) {
            container = document.createElement('div');
            container.id = 'qwest-toast-container';
            container.style.cssText = 'position:fixed;top:16px;right:16px;z-index:99999;display:flex;flex-direction:column;gap:8px;pointer-events:none;max-width:360px;';
            document.body.appendChild(container);
        }
        const toast = document.createElement('div');
        const colors = {
            info:    'background:#1f6feb;color:#fff;',
            warning: 'background:#fff3cd;color:#604000;border:1px solid #ffd966;',
            error:   'background:#fde2e2;color:#8a2222;border:1px solid #f4a8a8;',
            success: 'background:#d8f5e3;color:#1f6b3e;border:1px solid #8dd5a6;',
        };
        toast.style.cssText = 'padding:10px 14px;border-radius:6px;font:14px/1.4 sans-serif;box-shadow:0 4px 12px rgba(0,0,0,0.15);pointer-events:auto;cursor:pointer;opacity:0;transform:translateX(20px);transition:all 0.25s;'
                              + (colors[kind] || colors.info);
        toast.textContent = message;
        toast.addEventListener('click', () => toast.remove());
        container.appendChild(toast);
        // Animation d'entrée
        requestAnimationFrame(() => { toast.style.opacity = '1'; toast.style.transform = 'translateX(0)'; });
        // Auto-disparition
        setTimeout(() => {
            toast.style.opacity = '0';
            toast.style.transform = 'translateX(20px)';
            setTimeout(() => toast.remove(), 300);
        }, durationMs);
    }

    /**
     * UI helper : désactive un bouton + remplace son texte par un spinner pendant une action,
     * puis restaure son état initial. Retourne une fonction de restauration à appeler à la fin.
     */
    function lockButton(btnId, busyHtml) {
        const btn = document.getElementById(btnId);
        if (!btn) return () => {};
        const originalDisabled = btn.disabled;
        const originalHtml = btn.innerHTML;
        btn.disabled = true;
        if (busyHtml) btn.innerHTML = busyHtml;
        return () => {
            btn.disabled = originalDisabled;
            btn.innerHTML = originalHtml;
        };
    }

    /**
     * Avance à la question suivante.
     * @param {boolean} silent  Si true (cas auto-next du polling), aucune notification visible
     *                           en cas d'échec — le polling resynchronisera tout seul.
     *                           Si false (clic manuel), un toast non-bloquant est affiché.
     */
    async function nextQuestion(silent = false) {
        if (CONTROL_STATE.isPaused) {
            if (!silent) showToast('⚠️ La partie est en pause', 'warning');
            return;
        }

        if (CONTROL_STATE.autoNextQuestionPending) {
            console.log('🛑 PROF: Annulation du passage auto (clic manuel)');
            CONTROL_STATE.autoNextQuestionPending = false;
        }

        // Anti-double-clic : si une demande est déjà en cours, on ignore.
        if (CONTROL_STATE._nextInFlight) {
            console.log('⏳ PROF: nextQuestion déjà en cours, ignoré');
            return;
        }

        const totalQuestions = CONTROL_STATE.quizData?.questions?.length || APP_STATE.questions.length;
        // La cible est TOUJOURS « état serveur connu + 1 ». CONTROL_STATE.currentQuestion
        // est réconcilié depuis le serveur à chaque poll : si une avance précédente a été
        // engloutie côté serveur (lost update mutualisé), un nouveau clic RE-PROPOSE la
        // question jamais affichée au lieu de la sauter (avant : compteur optimiste local
        // → chaque clic post-incident sautait une question pour les élèves).
        const targetIndex = (CONTROL_STATE.currentQuestion ?? -1) + 1;

        if (targetIndex >= totalQuestions) {
            console.log('🏁 PROF: Fin de partie atteinte (cible', targetIndex, '>=', totalQuestions, ')');
            endGame(true);
            return;
        }

        CONTROL_STATE._nextInFlight = true;
        CONTROL_STATE.lastCommandTs = Date.now();
        const restoreNext = lockButton('btn-next-question', '⏳ Envoi…');
        const restoreNextMobile = lockButton('btn-next-question-mobile', '⏳ Envoi…');

        try {
            const result = await controlRequest('next_question', {
                playCode: CONTROL_STATE.playCode,
                questionIndex: targetIndex,
                customTime: CONTROL_STATE.customTime
            });

            if (result.ok) {
                const serverIndex = result.data.currentQuestion ?? result.data.alreadyAt ?? targetIndex;
                CONTROL_STATE.currentQuestion = serverIndex;
                // Mémoriser l'avance confirmée : le polling vérifiera que le serveur ne
                // « recule » pas en dessous (auto-réparation si écriture engloutie).
                CONTROL_STATE.lastCommandedQuestion = Math.max(CONTROL_STATE.lastCommandedQuestion ?? -1, serverIndex);
                CONTROL_STATE.lastCommandTs = Date.now();
                if (result.data.idempotent) {
                    console.log('ℹ️ PROF: nextQuestion idempotent, aligné sur Q' + serverIndex);
                }
                updateQuestionProgress();
                // Push immédiat aux fenêtres prof secondaires : c'est l'action la plus
                // sensible à la latence (passage à la question suivante doit s'aligner < 1 s).
                pushInstantSync();
            } else {
                console.error('❌ PROF: nextQuestion a échoué après retries', result.error || result.data);
                if (!silent) {
                    // Toast non-bloquant. Le polling à 3 s va re-synchroniser de toute façon.
                    showToast('Question suivante non confirmée. Synchronisation en cours…', 'warning', 4000);
                }
            }
        } finally {
            CONTROL_STATE._nextInFlight = false;
            restoreNext();
            restoreNextMobile();
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
            // Arrêter le polling (setTimeout adaptatif)
            if (controlPollingInterval) {
                console.log('🔴 PROF: Arrêt du polling...');
                clearTimeout(controlPollingInterval);
                controlPollingInterval = null;
                console.log('✅ PROF: Polling arrêté');
            }
            
            const response = await fetch('php/control.php', {
                method: 'POST',
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                body: new URLSearchParams({
                    action: 'end_game',
                    playCode: CONTROL_STATE.playCode,
                    teacher_hash: window.CONFIG?.TEACHER_PASSWORD_HASH || ''
                })
            });
            
            const result = await response.json();
            
            console.log('🏁 PROF: Réponse end_game:', result);
            
            if (result.success) {
                console.log('✅ PROF: Partie terminée avec succès');
                pushInstantSync();

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
                <td>${escapeHtml(player.nickname)}</td>
                <td>${escapeHtml(player.schoolName)}</td>
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
                                        <td class="student-name">${escapeHtml(player.nickname)}</td>
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
                <td class="student-name">${escapeHtml(player.nickname)}</td>
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
    let autoResyncTriggered = {}; // Track par questionIndex pour éviter de déclencher plusieurs fois
    let lastPollSuccessTs = 0;        // horodatage du dernier poll pilote réussi
    let runAdaptivePollNow = null;    // relance immédiate du poll (utilisé par le heartbeat projection)
    let autoNextFiredAt = {};         // questionIndex -> ts du dernier tir auto-next (anti re-tir + re-armement)
    let repairState = { inFlight: false, lastTs: 0, attemptsByQ: {} };

    /**
     * Remet à ZÉRO tout l'état de CONDUITE entre deux parties. À appeler au lancement
     * d'une nouvelle partie. BUG du 19/06 (corrigé) : le prof enchaînait des parties SANS
     * recharger la fenêtre de pilotage ; `lastCommandedQuestion` (et repairState / auto-next
     * / lastResultsQuestionIndex) gardaient la DERNIÈRE question de la partie PRÉCÉDENTE.
     * Au démarrage suivant, maybeRepairLostAdvance voyait serveur(0) < voulu(24) et
     * ré-émettait next_question(24) → la nouvelle partie SAUTAIT à la fin et « s'arrêtait
     * subitement » (mesuré : 35KHY3 0→24, 5RVDJU 0→29, HDC874 -1→29).
     */
    function resetConductorState() {
        CONTROL_STATE.currentQuestion = -1;
        CONTROL_STATE.lastCommandedQuestion = null;
        CONTROL_STATE.autoNextQuestionPending = false;
        CONTROL_STATE.autoNextTimestamp = null;
        CONTROL_STATE._nextInFlight = false;
        if (CONTROL_STATE.autoNextCheckInterval) {
            clearInterval(CONTROL_STATE.autoNextCheckInterval);
            CONTROL_STATE.autoNextCheckInterval = null;
        }
        lastResultsQuestionIndex = -1;
        autoResyncTriggered = {};
        autoNextFiredAt = {};
        repairState = { inFlight: false, lastTs: 0, attemptsByQ: {} };
        console.log('🔄 PROF: état de conduite réinitialisé (nouvelle partie)');
    }
    window.__resetConductorState = resetConductorState;

    /**
     * AUTO-RÉPARATION (anti lost-update hébergement mutualisé).
     * Si le serveur annonce un currentQuestion INFÉRIEUR à la dernière avance confirmée
     * (lastCommandedQuestion), c'est qu'une écriture next_question a été engloutie par
     * une écriture concurrente (copie périmée réécrite par-dessus). On ré-émet alors la
     * commande : côté serveur elle est idempotente et MONOTONE (questionIndex <= courant
     * → no-op), donc sur-émettre est sans danger ; elle ne peut que restaurer l'avance.
     * Garde-fous : 1 réparation à la fois, 3 s min entre deux, 5 tentatives max par
     * question (au-delà : toast pour le prof, qui peut recliquer).
     */
    async function maybeRepairLostAdvance(data) {
        const wanted = CONTROL_STATE.lastCommandedQuestion;
        if (wanted == null || typeof data.currentQuestion !== 'number') return;
        if (data.currentQuestion >= wanted) {
            // Serveur à jour (ou au-delà) : réinitialiser le compteur de tentatives.
            repairState.attemptsByQ = {};
            return;
        }
        if (data.state !== 'playing') return;
        if (CONTROL_STATE.isPaused || CONTROL_STATE._nextInFlight || repairState.inFlight) return;
        if (Date.now() - repairState.lastTs < 3000) return;

        const attempts = repairState.attemptsByQ[wanted] || 0;
        if (attempts >= 5) {
            return; // toast déjà affiché à la 5ᵉ tentative
        }
        repairState.inFlight = true;
        repairState.lastTs = Date.now();
        repairState.attemptsByQ[wanted] = attempts + 1;
        console.warn('🛠️ PROF: avance perdue détectée (serveur Q' + data.currentQuestion +
                     ' < confirmé Q' + wanted + ') — ré-émission (tentative ' + (attempts + 1) + ')');
        try {
            const result = await controlRequest('next_question', {
                playCode: CONTROL_STATE.playCode,
                questionIndex: wanted,
                customTime: CONTROL_STATE.customTime
            });
            if (result.ok) {
                const serverIndex = result.data.currentQuestion ?? result.data.alreadyAt ?? wanted;
                CONTROL_STATE.currentQuestion = Math.max(CONTROL_STATE.currentQuestion ?? -1, serverIndex);
                CONTROL_STATE.lastCommandTs = Date.now();
                updateQuestionProgress();
                pushInstantSync();
                console.log('🛠️ PROF: avance Q' + wanted + ' restaurée');
            } else if ((repairState.attemptsByQ[wanted] || 0) >= 5) {
                showToast('⚠️ La question n\'a pas pu être relancée automatiquement. Reclique sur « Question suivante ».', 'warning', 6000);
            }
        } finally {
            repairState.inFlight = false;
        }
    }

    /**
     * Tir de l'avance automatique si l'échéance est atteinte. Appelé par TROIS voies
     * complémentaires (la première qui passe gagne, le flag pending évite les doublons) :
     *   1. l'interval 500 ms du pilote (précis quand l'onglet pilote est visible),
     *   2. chaque poll pilote (fonctionne même throttlé),
     *   3. le heartbeat 1 s de la projection (fenêtre TBI toujours visible — voie fiable
     *      quand le pilote est en onglet caché, cas « un seul écran » où l'on a mesuré
     *      des avances auto retardées à 60 s pile par le throttling navigateur).
     */
    function checkAutoNextDeadline() {
        if (CONTROL_STATE.autoNextQuestionPending &&
            !CONTROL_STATE.isPaused &&
            !CONTROL_STATE._nextInFlight &&
            Date.now() >= CONTROL_STATE.autoNextTimestamp) {

            CONTROL_STATE.autoNextQuestionPending = false;
            autoNextFiredAt[(CONTROL_STATE.currentQuestion ?? -1)] = Date.now();
            console.log('⏰ PROF: Lancement auto de la question suivante (silencieux)');
            nextQuestion(true); // silent=true : pas d'alerte si le polling synchronisera
        }
    }


    function startControlPolling() {
        console.log('🔄 PROF: Démarrage du polling adaptatif côté pilote');

        // Arrêter le polling existant si présent (setTimeout adaptatif)
        if (controlPollingInterval) {
            clearTimeout(controlPollingInterval);
            controlPollingInterval = null;
        }
        
        const poll = async () => {
            if (!CONTROL_STATE.playCode) {
                return;
            }

            // Circuit breaker : si en pause, ne pas envoyer de requête
            if (profIsCircuitPaused()) {
                return;
            }

            try {
                const response = await fetch(`php/control.php?action=get_control_state&playCode=${CONTROL_STATE.playCode}`);
                if (!response.ok) {
                    const retryAfterMs = profParseRetryAfterMs(response);
                    console.warn('⚠️ PROF: polling HTTP', response.status);
                    profRecordError(retryAfterMs);
                    return;
                }
                const data = await response.json();

                if (!data.success) {
                    console.error('❌ PROF: Erreur polling:', data.message);
                    return;
                }
                // Succès : reset CB
                profResetCircuit();
                lastPollSuccessTs = Date.now();

                // Mémoriser le timing pour piloter la cadence adaptative (transition window).
                CONTROL_STATE.lastTimeElapsed = (typeof data.timeElapsed === 'number') ? data.timeElapsed : null;
                CONTROL_STATE.lastQuestionTime = (typeof data.questionTime === 'number') ? data.questionTime : null;
                CONTROL_STATE.lastQuestionStartTime = (typeof data.questionStartTime === 'number') ? data.questionStartTime : null;

                // ========================================
                // RÉCONCILIATION AVEC LE SERVEUR (anti lost-update)
                // ========================================
                // Le serveur est la VÉRITÉ. Sur l'hébergement mutualisé (cluster + NFS),
                // une écriture next_question peut être engloutie par une écriture
                // concurrente porteuse d'une copie périmée : l'état serveur « recule »
                // alors que le pilote a reçu un succès. Sans réconciliation, le pilote
                // vivait dans le futur : élèves bloqués sur le Top 3, puis question
                // sautée au clic suivant (45 avances perdues mesurées le 12/06).
                CONTROL_STATE.state = (typeof data.state === 'string') ? data.state : CONTROL_STATE.state;

                // Pause : suivre le serveur (sauf si un toggle est en cours d'envoi).
                if (typeof data.paused === 'boolean' && !CONTROL_STATE._pausePending &&
                    data.paused !== CONTROL_STATE.isPaused) {
                    console.log('🔁 PROF: état pause réconcilié depuis le serveur →', data.paused);
                    CONTROL_STATE.isPaused = data.paused;
                    const btnPause = document.getElementById('btn-pause-game');
                    if (btnPause) btnPause.innerHTML = data.paused ? '▶️ Reprendre' : '⏸️ Pause';
                }

                if (typeof data.currentQuestion === 'number') {
                    const sinceCmd = Date.now() - (CONTROL_STATE.lastCommandTs || 0);
                    if (sinceCmd <= 2500) {
                        // Fenêtre optimiste : une commande vient de partir, le poll peut
                        // renvoyer un état antérieur sans que ce soit une anomalie.
                        CONTROL_STATE.currentQuestion = Math.max(CONTROL_STATE.currentQuestion ?? -1, data.currentQuestion);
                    } else {
                        if (data.currentQuestion !== CONTROL_STATE.currentQuestion) {
                            console.log('🔁 PROF: currentQuestion réconcilié', CONTROL_STATE.currentQuestion, '→', data.currentQuestion);
                            CONTROL_STATE.currentQuestion = data.currentQuestion;
                            updateQuestionProgress();
                        }
                        // AUTO-RÉPARATION : le serveur est REVENU en dessous d'une avance
                        // pourtant confirmée → on ré-émet la commande (idempotente côté
                        // serveur, et monotone : elle ne peut qu'avancer, jamais reculer).
                        maybeRepairLostAdvance(data);
                    }
                }

                // Mise à jour de la liste des joueurs
                if (data.players) {
                    updateControlPlayersList(data.players);
                }
                
                // ========================================
                // RESYNCHRONISATION AUTOMATIQUE
                // ========================================
                // Si le temps est écoulé depuis 5+ secondes et que la question n'est pas complétée,
                // forcer automatiquement la completion (pour éviter que toute la classe reste bloquée)
                if (data.state === 'playing' && 
                    data.currentQuestion >= 0 && 
                    data.timeElapsed !== undefined && 
                    data.questionTime !== undefined && 
                    !data.questionCompleted &&
                    !CONTROL_STATE.isPaused) {
                    
                    const timeOverdue = data.timeElapsed - data.questionTime;
                    
                    // Si le temps est dépassé de plus de 3 secondes (cohérent avec serveur)
                    if (timeOverdue >= 3) {
                        // Vérifier qu'on n'a pas déjà déclenché la resync pour cette question
                        if (!autoResyncTriggered[data.currentQuestion]) {
                            autoResyncTriggered[data.currentQuestion] = true;
                            
                            console.log('⏰ PROF: RESYNC AUTO - Temps écoulé depuis ' + timeOverdue + 's, forçage de la question ' + data.currentQuestion);
                            
                            // Resync auto via le helper (retry exponentiel + idempotence côté serveur)
                            const resyncResult = await controlRequest('force_question_complete', {
                                playCode: CONTROL_STATE.playCode,
                                questionIndex: data.currentQuestion
                            });
                            if (resyncResult.ok) {
                                console.log('✅ PROF: RESYNC AUTO réussie pour Q' + data.currentQuestion +
                                            (resyncResult.data.idempotent ? ' (idempotent)' : ''));
                            } else {
                                console.error('❌ PROF: RESYNC AUTO échouée', resyncResult.error || resyncResult.data);
                                // On retire le flag pour permettre une nouvelle tentative au prochain polling
                                delete autoResyncTriggered[data.currentQuestion];
                            }
                        }
                    } else {
                        // Log uniquement si on approche de la deadline
                        if (timeOverdue >= 0 && timeOverdue < 3) {
                            console.log('⏰ PROF: Temps écoulé, resync auto dans ' + (3 - timeOverdue) + 's si pas de réponses');
                        }
                    }
                }
                
                // Détecter si des résultats sont disponibles
                if (data.resultsAvailable && data.questionIndex === data.currentQuestion) {
                    const isNewResults = (data.questionIndex !== lastResultsQuestionIndex);
                    if (isNewResults) {
                        console.log('🟢 PROF: Résultats reçus pour question', data.questionIndex);
                        lastResultsQuestionIndex = data.questionIndex;
                    }

                    // En mode automatique, programmer l'avance. SYNCHRO v2 : l'apparition
                    // réelle = ce délai + REVEAL_LEAD_MS (le serveur fixe revealAt à
                    // l'instruction). On raccourcit donc le délai pour garder un rythme
                    // ~équivalent à l'ancien (délai 5 s + révélation 1,5 s = 6,5 s).
                    if (!CONTROL_STATE.manualMode) {
                        const autoDelay = (window.CONFIG && window.CONFIG.AUTO_NEXT_DELAY_MS) || 3500;
                        const firedAt = autoNextFiredAt[data.questionIndex] || 0;
                        if (isNewResults) {
                            console.log('⏰ PROF: Passage auto à la question suivante dans ' + Math.round(autoDelay / 1000) + 's (+ lead révélation)');
                            CONTROL_STATE.autoNextTimestamp = Date.now() + autoDelay;
                            CONTROL_STATE.autoNextQuestionPending = true;
                        } else if (!CONTROL_STATE.autoNextQuestionPending &&
                                   !CONTROL_STATE._nextInFlight &&
                                   (Date.now() - firedAt) > 8000) {
                            // RE-ARMEMENT : les résultats de cette question sont TOUJOURS
                            // affichés alors que l'avance auto aurait dû partir (tir raté
                            // pour cause de réseau/CB, onglet throttlé, ou avance engloutie
                            // côté serveur). Avant, le one-shot sur lastResultsQuestionIndex
                            // laissait toute la classe bloquée sur le Top 3 jusqu'à un clic
                            // manuel — qui, en plus, sautait une question.
                            console.warn('⏰ PROF: auto-next bloqué sur Q' + data.questionIndex + ' — re-armement (1,5 s)');
                            CONTROL_STATE.autoNextTimestamp = Date.now() + 1500;
                            CONTROL_STATE.autoNextQuestionPending = true;
                        }

                        if (!CONTROL_STATE.autoNextCheckInterval) {
                            // NB : en onglet caché, ce setInterval est throttlé par le
                            // navigateur (jusqu'à 1 tick/min). Le même contrôle est donc
                            // AUSSI fait à chaque poll et par le heartbeat de la projection
                            // (fenêtre visible sur le TBI) via window.projectionHeartbeat.
                            CONTROL_STATE.autoNextCheckInterval = setInterval(checkAutoNextDeadline, 500);
                        }
                    }
                }
                // Filet de sécurité : tenter le tir auto même si ce poll n'a pas de résultats
                // (cas onglet caché où l'interval 500 ms ne tourne plus).
                checkAutoNextDeadline();
                
            } catch (error) {
                console.error('❌ PROF: Erreur polling:', error);
                profRecordError(0);
            }
        };

        // Polling adaptatif côté pilote :
        //   - 1,5 s pendant qu'une question est active (CONTROL_POLL_INTERVAL_QUESTION)
        //   - 2,5 s en attente / résultats (CONTROL_POLL_INTERVAL_IDLE)
        //   - 400 ms en fenêtre de transition (juste après un changement OU fin de question imminente)
        // Avec un jitter ±15 % pour éviter la synchronisation des frappes serveur.
        const CTRL_Q  = (window.CONFIG && window.CONFIG.CONTROL_POLL_INTERVAL_QUESTION) || 1500;
        const CTRL_I  = (window.CONFIG && window.CONFIG.CONTROL_POLL_INTERVAL_IDLE)     || 2500;
        const CTRL_T  = (window.CONFIG && window.CONFIG.POLL_INTERVAL_TRANSITION)       || 400;
        const CTRL_TW = (window.CONFIG && window.CONFIG.POLL_TRANSITION_WINDOW_MS)      || 4000;
        const CTRL_PT = (window.CONFIG && window.CONFIG.POLL_PRE_TRANSITION_SECONDS)    || 2;
        const CTRL_J  = (window.CONFIG && window.CONFIG.POLL_JITTER_RATIO)              || 0.15;

        let adaptivePollRunning = false;
        const adaptivePoll = async () => {
            if (adaptivePollRunning) return;
            adaptivePollRunning = true;
            try {
                await poll();
            } finally {
                adaptivePollRunning = false;
            }

            // Fenêtre de transition côté pilote : juste après un changement (questionStartTime
            // récent < CTRL_TW), OU fin de question imminente (timeRemaining < CTRL_PT).
            const qst = CONTROL_STATE.lastQuestionStartTime;
            const elapsed = CONTROL_STATE.lastTimeElapsed;
            const qTime = CONTROL_STATE.lastQuestionTime;
            const nowSec = Math.floor(Date.now() / 1000);
            const inPostTransition = (typeof qst === 'number' && qst > 0)
                                     ? ((nowSec - qst) * 1000 < CTRL_TW)
                                     : false;
            const inPreTransition = (typeof elapsed === 'number' && typeof qTime === 'number' && qTime > 0)
                                    ? ((qTime - elapsed) <= CTRL_PT && elapsed >= 0)
                                    : false;

            let base;
            if (inPostTransition || inPreTransition) {
                base = CTRL_T;
            } else {
                const isQuestionActive = (CONTROL_STATE.currentQuestion ?? -1) >= 0
                                         && CONTROL_STATE.state !== 'finished';
                base = isQuestionActive ? CTRL_Q : CTRL_I;
            }
            const jitter = (Math.random() * 2 - 1) * CTRL_J;
            let delay = Math.max(300, Math.round(base * (1 + jitter)));
            // Si le circuit breaker est ouvert, on attend au moins la fin de la pause
            const pauseDelay = profTimeUntilReopens();
            if (pauseDelay > 0) {
                delay = Math.max(delay, pauseDelay + 100);
            }
            controlPollingInterval = setTimeout(adaptivePoll, delay);
        };

        // Relance immédiate déclenchable de l'extérieur (heartbeat projection) : quand
        // l'onglet pilote est caché, ses setTimeout sont throttlés (jusqu'à 1/min) ; la
        // projection, toujours visible, peut ainsi maintenir la cadence du poll pilote.
        runAdaptivePollNow = () => {
            if (adaptivePollRunning) return;
            if (controlPollingInterval) {
                clearTimeout(controlPollingInterval);
                controlPollingInterval = null;
            }
            adaptivePoll();
        };

        // Première requête immédiate, les suivantes sont réarmées dans adaptivePoll
        adaptivePoll();
    }

    /**
     * Battement de cœur appelé toutes les secondes par la FENÊTRE PROJECTION (qui, étant
     * affichée au TBI, n'est jamais throttlée par le navigateur). Compense le throttling
     * de l'onglet pilote quand il est caché (cas fréquent : un seul écran en classe,
     * projection en plein écran par-dessus le pilote) :
     *   - tire l'avance automatique dont l'échéance est dépassée,
     *   - relance le poll pilote s'il a plus de 4 s de retard (resync auto + réparation
     *     d'avance perdue incluses),
     *   - rafraîchit la projection si sa dernière mise à jour date de plus de 4 s.
     * Sans projection ouverte, ce heartbeat n'existe pas et le pilote fonctionne comme
     * avant (intervalles propres tant que son onglet est visible).
     */
    window.projectionHeartbeat = function() {
        try {
            if (!CONTROL_STATE.playCode) return;
            checkAutoNextDeadline();
            if (typeof runAdaptivePollNow === 'function' &&
                (Date.now() - lastPollSuccessTs) > 4000 && !profIsCircuitPaused()) {
                runAdaptivePollNow();
            }
            if ((Date.now() - lastProjectionPushTs) > 4000 && !profIsCircuitPaused()) {
                updateProjectionWindow();
            }
        } catch (e) {
            console.warn('💓 PROJECTION heartbeat: erreur ignorée', e);
        }
    };
    
    // ========================================
    // RESYNCHRONISATION D'URGENCE
    // ========================================
    
    window.forceResync = async function() {
        if (!confirm('🔄 Forcer la resynchronisation ?\n\nCela va forcer l\'affichage des résultats actuels pour tous les élèves.\nUtilisez ceci uniquement si les élèves sont bloqués.')) {
            return;
        }

        const restore1 = lockButton('btn-resync', '⏳ Resync…');
        const restore2 = lockButton('btn-resync-mobile', '⏳ Resync…');

        try {
            const result = await controlRequest('force_question_complete', {
                playCode: CONTROL_STATE.playCode,
                questionIndex: CONTROL_STATE.currentQuestion
            });

            if (result.ok) {
                if (result.data.idempotent) {
                    showToast('ℹ️ Question déjà complétée — les élèves voient les résultats.', 'info', 4000);
                } else {
                    showToast('✅ Resynchronisation effectuée !', 'success', 4000);
                }
                pushInstantSync();
            } else {
                console.error('❌ PROF: resync échouée', result.error || result.data);
                showToast('❌ Resynchronisation non confirmée. Réessaye dans un instant.', 'error', 5000);
            }
        } finally {
            restore1();
            restore2();
        }
    };

    // ========================================
    // MODE PROJECTION
    // ========================================
    
    let projectionWindow = null;
    let projectionUpdateInterval = null;
    let teacherWindow = null;
    let lastProjectionPushTs = 0;     // dernier update projection abouti (pour le heartbeat)
    let lastProjectionFetchTs = 0;    // anti-doublon : updateProjectionWindow max ~1/s
    
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
        // Polling autonome de la projection (3 s) — la projection reste à jour même si la
        // fenêtre prof est fermée ou en perte de connexion. Cadence dédiée (3 s) pour
        // réduire le volume get_control_state ; l'immédiateté vient de pushInstantSync.
        const interval = (window.CONFIG && window.CONFIG.PROJECTION_POLL_INTERVAL_MS) || 3000;
        console.log('📽️ PROJECTION: Démarrage du polling toutes les ' + interval + ' ms');
        projectionUpdateInterval = setInterval(() => {
            updateProjectionWindow();
        }, interval);
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
        
        // Calculer le nombre de questions prévu (tenant compte de la limite si cochée)
        let plannedQuestionCount = APP_STATE.questions.length;
        const checkLimitQuestions = document.getElementById('limit-questions-check');
        const limitQuestionsInput = document.getElementById('limit-questions-input');
        
        if (checkLimitQuestions && checkLimitQuestions.checked && limitQuestionsInput) {
            const limit = parseInt(limitQuestionsInput.value) || 10;
            plannedQuestionCount = Math.min(limit, APP_STATE.questions.length);
        }
        
        // Si la partie a déjà commencé, utiliser le nombre réel de questions
        if (CONTROL_STATE.quizData?.questions?.length) {
            plannedQuestionCount = CONTROL_STATE.quizData.questions.length;
        }
        
        // Si le circuit breaker prof est en pause, ne pas envoyer
        if (profIsCircuitPaused()) {
            return;
        }

        // Anti-rafale : l'update peut être déclenché par l'interval (3 s), pushInstantSync
        // ET le heartbeat projection — on borne à ~1 requête/s.
        if (Date.now() - lastProjectionFetchTs < 900) {
            return;
        }
        lastProjectionFetchTs = Date.now();

        // Récupérer l'état du jeu via le serveur
        fetch('php/control.php?action=get_control_state&playCode=' + CONTROL_STATE.playCode)
            .then(res => {
                if (!res.ok) {
                    const retryAfterMs = profParseRetryAfterMs(res);
                    profRecordError(retryAfterMs);
                    throw new Error('HTTP ' + res.status);
                }
                return res.json();
            })
            .then(result => {
                if (!result.success) {
                    console.error('❌ PROJECTION: Erreur API', result);
                    return;
                }
                profResetCircuit();
                lastProjectionPushTs = Date.now();

                console.log('📽️ PROJECTION: État reçu', result.state, 'Q' + result.currentQuestion,
                    result.questionCompleted ? '✅completed' : '', result.resultsAvailable ? '📊results' : '');
                
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
                    questions: CONTROL_STATE.quizData?.questions || APP_STATE.questions,
                    totalQuestions: plannedQuestionCount, // NOUVEAU : Toujours envoyer le nombre prévu
                    // SYNCHRO v2 : instant absolu d'apparition (ms serveur) + horloge serveur
                    // ms — la projection révèle la question via son horloge synchronisée, au
                    // même instant que les postes élèves.
                    revealAt: (typeof result.questionRevealAt === 'number') ? result.questionRevealAt : 0,
                    serverTimeMs: (typeof result.serverTimeMs === 'number') ? result.serverTimeMs : 0
                };
                
                // Tri STABLE et déterministe (anti-scintillement) : score décroissant,
                // puis pseudo (départage des ex æquo). Évite que les ex æquo permutent
                // d'un poll à l'autre.
                const stableSort = function(players) {
                    return players.slice().sort(function(a, b) {
                        const d = (b.score || 0) - (a.score || 0);
                        if (d !== 0) return d;
                        return String(a.nickname || '').localeCompare(String(b.nickname || ''));
                    });
                };

                // Détecter l'écran actuel selon l'état du serveur
                if (result.state === 'finished' || result.state === 'ended') {
                    console.log('📽️ PROJECTION: Affichage écran final');
                    data.screen = 'final';
                    data.allPlayers = result.ranking || stableSort(result.players);
                } else if (result.questionCompleted || result.resultsAvailable) {
                    // Phase "résultats" : utiliser le classement FIGÉ par le serveur
                    // (result.ranking) → l'ordre ne bouge plus malgré les réponses
                    // tardives. Repli : tri stable si pas d'instantané.
                    console.log('📽️ PROJECTION: Affichage classement général');
                    data.screen = 'ranking';
                    const ranked = result.ranking || stableSort(result.players);
                    data.allPlayers = ranked;
                    data.top3 = ranked.slice(0, 3);
                } else if (result.state === 'playing' && result.currentQuestion >= 0) {
                    console.log('📽️ PROJECTION: Affichage question', result.currentQuestion);
                    data.screen = 'question';
                    // Timing serveur → la projection aligne le compte à rebours pour
                    // révéler la question EN MÊME TEMPS que les postes élèves (pas avant).
                    data.timeElapsed = (typeof result.timeElapsed === 'number') ? result.timeElapsed : 0;
                    data.questionTime = result.questionTime;
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
                profRecordError(0);
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
    // QR CODE
    // ========================================

    /**
     * Construit l'URL de la page d'accueil avec le code pré-rempli.
     * Fonctionne quelle que soit la profondeur du chemin de déploiement.
     */
    function buildJoinUrl(playCode) {
        const base = window.location.origin + window.location.pathname
                        .replace(/\/[^/]*$/, '/'); // garder le dossier, retirer le fichier
        return base + 'index.html?code=' + encodeURIComponent(playCode);
    }

    /**
     * Génère le QR code miniature dans le bouton du header.
     * Remplace l'icône ⬛ par le vrai QR rendu par qrcodejs.
     */
    function generateQrMini(playCode) {
        const btn = document.querySelector('.qr-btn');
        if (!btn || typeof QRCode === 'undefined') return;

        const icon = btn.querySelector('.qr-icon');
        if (!icon) return;

        // Remplacer l'icône par un conteneur pour le QR
        icon.innerHTML = '';
        icon.style.cssText = 'display:flex;align-items:center;justify-content:center;width:36px;height:36px;';

        try {
            new QRCode(icon, {
                text: buildJoinUrl(playCode),
                width: 36,
                height: 36,
                colorDark: '#1a1a2e',
                colorLight: '#ffffff',
                correctLevel: QRCode.CorrectLevel.M
            });
        } catch(e) {
            icon.textContent = '⬛';
        }
    }

    /**
     * Affiche le QR code en grand dans un modal plein écran.
     * Clic n'importe où sur le modal le ferme.
     */
    function showQrModal() {
        const playCode = CONTROL_STATE.playCode;
        if (!playCode) return;

        // Créer le modal s'il n'existe pas encore
        let modal = document.getElementById('qr-modal');
        if (!modal) {
            modal = document.createElement('div');
            modal.id = 'qr-modal';
            modal.className = 'qr-modal';
            modal.innerHTML = `
                <div class="qr-modal-backdrop" onclick="closeQrModal()"></div>
                <div class="qr-modal-content">
                    <div class="qr-modal-header">
                        <div class="qr-modal-title">Scanner pour rejoindre</div>
                        <button class="qr-modal-close" onclick="closeQrModal()">✕</button>
                    </div>
                    <div id="qr-modal-canvas"></div>
                    <div class="qr-modal-code">${playCode}</div>
                    <div class="qr-modal-url" id="qr-modal-url"></div>
                </div>
            `;
            document.body.appendChild(modal);
        }

        // Afficher le modal
        modal.classList.add('active');
        document.getElementById('qr-modal-url').textContent = buildJoinUrl(playCode);

        // Générer le grand QR (vider d'abord)
        const canvas = document.getElementById('qr-modal-canvas');
        canvas.innerHTML = '';
        if (typeof QRCode !== 'undefined') {
            new QRCode(canvas, {
                text: buildJoinUrl(playCode),
                width: 260,
                height: 260,
                colorDark: '#1a1a2e',
                colorLight: '#ffffff',
                correctLevel: QRCode.CorrectLevel.M
            });
        }
    }

    function closeQrModal() {
        const modal = document.getElementById('qr-modal');
        if (modal) modal.classList.remove('active');
    }

    // ========================================
    // EXPORT VERS GLOBAL
    // ========================================
    
    // TEMPORAIRE : bouton de monitoring depuis le panel prof. À retirer
    // une fois l'app stabilisée (cf. lien dans index.html, modal #control-modal).
    // Le dashboard est à la racine (dashboard.html / dashboard.php) pour rester
    // accessible depuis le poste prof au collège — protégé par teacher_hash côté PHP.
    function openMetricsDashboard() {
        const hash = (window.CONFIG && window.CONFIG.TEACHER_PASSWORD_HASH) || '';
        if (!hash) {
            alert('⚠️ Hash prof introuvable. Ouvre la console pour diagnostiquer.');
            return;
        }
        const url = 'dashboard.html?teacher_hash=' + encodeURIComponent(hash);
        window.open(url, 'qwest-metrics', 'width=1100,height=820');
    }
    window.openMetricsDashboard = openMetricsDashboard;

    window.openControlPanel = openControlPanel;
    window.openTeacherPlay = openTeacherPlay;
    window.closeControlPanel = closeControlPanel;
    window.startGame = startGame;
    window.pauseGame = pauseGame;
    window.nextQuestion = nextQuestion;
    window.CONTROL_STATE = CONTROL_STATE; // exposé pour diagnostic (comme APP_STATE/SESSION_STATE)
    window.endGame = endGame;
    window.refreshPlayers = refreshPlayers;
    window.showFullScoreboard = showFullScoreboard;
    window.showGradingTable = showGradingTable;
    window.toggleManualMode = toggleManualMode;
    window.toggleShowTop3 = toggleShowTop3;
    window.toggleSection = toggleSection;
    window.toggleQuestionPreview = toggleQuestionPreview;
    window.closeQuestionPreview = closeQuestionPreview;
    window.openProjectionMode = openProjectionMode;
    window.showQrModal = showQrModal;
    window.closeQrModal = closeQrModal;
    // Exposé pour permettre à projection.html (window.forceUpdate) et à teacher-play.html
    // de demander une resync immédiate à la fenêtre prof, sans attendre le polling.
    window.updateProjectionWindow = updateProjectionWindow;

})();
