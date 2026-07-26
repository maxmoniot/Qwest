// ============================================
// MODULE: CLOCK SYNC (synchronisation horloge serveur — refonte synchro v2)
// ============================================
//
// Tous les postes (élèves, « je participe aussi », projection) synchronisent leur
// horloge sur celle du SERVEUR — pas un serveur de temps externe, mais NOTRE propre
// PHP, joignable à chaque requête. Avantages vs une horloge de temps tierce :
//   - aucune dépendance externe (rien à bloquer pour le pare-feu du collège) ;
//   - le serveur fait DÉJÀ autorité sur l'état de la partie → une seule référence ;
//   - latence faible et maîtrisée → estimation d'offset précise.
//
// Algorithme de Cristian : on mesure l'aller-retour (RTT) d'un échantillon `time_sync`,
// et on estime l'heure serveur À LA RÉCEPTION ≈ serverTimeMs + RTT/2 (hypothèse de
// latence symétrique). offset = (serverTimeMs + RTT/2) - clientRecvMs. On garde
// l'échantillon de plus faible RTT (le plus fiable). La dérive d'un quartz étant
// négligeable (< quelques ms sur une partie), une resynchro/minute suffit largement.
//
// Une fois synchronisé, QwestClock.now() renvoie l'heure SERVEUR estimée en ms. C'est
// CETTE horloge (et non Date.now() brut, qui peut être faux de plusieurs minutes sur
// le téléphone d'un élève) qui pilote la révélation alignée des questions et le timer
// visuel. Le calcul des POINTS, lui, reste mesuré en durée LOCALE (insensible au
// réseau et à l'horloge) — voir game.js.

(function() {
    'use strict';

    const CFG = window.CONFIG || {};
    const SAMPLES      = CFG.CLOCK_SYNC_SAMPLES   || 5;
    const INTERVAL_MS  = CFG.CLOCK_SYNC_INTERVAL_MS || 60000;
    const TIMEOUT_MS   = CFG.CLOCK_SYNC_TIMEOUT_MS || 4000;

    // Endpoint relatif — identique depuis index.html, teacher-play.html, projection.html
    // (tous à la racine). Surchargé possible via window.QWEST_GAME_ENDPOINT.
    function endpoint() {
        return window.QWEST_GAME_ENDPOINT || 'php/game.php';
    }

    const QwestClock = {
        offset: 0,           // (heure serveur - heure locale) en ms
        bestRtt: Infinity,   // RTT de l'échantillon ayant fixé l'offset courant
        syncedAt: 0,         // Date.now() du dernier échantillon accepté
        synced: false,
        _syncing: false,
        _timer: null,

        /** Heure SERVEUR estimée, en ms. Avant toute synchro : retombe sur l'heure locale. */
        now() {
            return Date.now() + this.offset;
        },

        /** true si l'horloge a été synchronisée et n'est pas périmée. */
        isFresh() {
            return this.synced && (Date.now() - this.syncedAt) < (INTERVAL_MS * 3);
        },

        /** Un aller-retour time_sync. Retourne {offset, rtt} ou null. */
        async _probe() {
            const t0 = Date.now();
            const controller = new AbortController();
            const to = setTimeout(() => controller.abort(), TIMEOUT_MS);
            let resp;
            try {
                resp = await fetch(endpoint() + '?action=time_sync' + idQuery(), { signal: controller.signal });
            } catch (e) {
                clearTimeout(to);
                return null;
            }
            clearTimeout(to);
            const t1 = Date.now();
            if (!resp.ok) return null;
            let data;
            try { data = await resp.json(); } catch (e) { return null; }
            if (!data || typeof data.serverTimeMs !== 'number') return null;
            const rtt = Math.max(0, t1 - t0);
            // Heure serveur estimée à l'instant t1 (réception) ≈ serverTimeMs + rtt/2.
            const offset = (data.serverTimeMs + rtt / 2) - t1;
            return { offset, rtt };
        },

        /**
         * Resynchronise : plusieurs échantillons, on adopte celui de plus faible RTT.
         * Idempotent (un seul en vol). Retourne une promesse résolue à la fin.
         */
        async sync(samples) {
            if (this._syncing) return;
            this._syncing = true;
            samples = samples || SAMPLES;
            let best = null;
            try {
                for (let i = 0; i < samples; i++) {
                    const s = await this._probe();
                    if (s && (best === null || s.rtt < best.rtt)) best = s;
                    // petit espacement pour varier les conditions réseau
                    if (i < samples - 1) await new Promise(r => setTimeout(r, 120));
                }
            } finally {
                this._syncing = false;
            }
            if (best) {
                this.offset = best.offset;
                this.bestRtt = best.rtt;
                this.syncedAt = Date.now();
                this.synced = true;
                if (window.recordClientEvent) {
                    window.recordClientEvent('clock_sync', { offsetMs: Math.round(best.offset), rttMs: Math.round(best.rtt) });
                }
                console.log('🕐 Horloge synchronisée : offset', Math.round(best.offset), 'ms (RTT', Math.round(best.rtt), 'ms)');
            }
            return best;
        },

        /**
         * Correction OPPORTUNISTE depuis un poll qui a renvoyé serverTimeMs : si le
         * RTT mesuré (t1-t0) est MEILLEUR que l'échantillon courant, on réajuste sans
         * frais réseau. Plus prudent qu'un time_sync (le serveur lit l'heure au milieu
         * d'un traitement non symétrique), d'où la condition « strictement meilleur ».
         */
        observe(serverTimeMs, t0, t1) {
            if (typeof serverTimeMs !== 'number' || !t0 || !t1) return;
            const rtt = Math.max(0, t1 - t0);
            // On laisse le meilleur RTT « vieillir » : sans ça, un unique très bon
            // échantillon figerait l'offset et empêcherait toute correction de dérive.
            const aged = this.bestRtt + Math.max(0, (Date.now() - this.syncedAt)) / 50;
            if (rtt <= aged) {
                this.offset = (serverTimeMs + rtt / 2) - t1;
                this.bestRtt = rtt;
                this.syncedAt = Date.now();
                this.synced = true;
            }
        },

        /** Démarre la resynchro périodique (et une synchro immédiate). */
        start() {
            this.sync();
            if (this._timer) clearInterval(this._timer);
            this._timer = setInterval(() => { this.sync(); }, INTERVAL_MS);
        },

        stop() {
            if (this._timer) { clearInterval(this._timer); this._timer = null; }
        }
    };

    /** playCode+nickname en query (pour que time_sync compte dans le bon budget de throttle). */
    function idQuery() {
        try {
            const st = window.SESSION_STATE;
            if (st && st.playCode && st.playerNickname) {
                return '&playCode=' + encodeURIComponent(st.playCode) +
                       '&nickname=' + encodeURIComponent(st.playerNickname);
            }
        } catch (e) {}
        return '';
    }

    window.QwestClock = QwestClock;
    // Raccourci pratique : heure serveur estimée en ms.
    window.qwestServerNow = function() { return QwestClock.now(); };

    // Resynchro au retour d'onglet en avant-plan (l'horloge a pu dériver/être ajustée,
    // et les timers d'arrière-plan ont été throttlés). Léger : un seul échantillon suffit
    // à recaler, la synchro complète suit au prochain tick périodique.
    document.addEventListener('visibilitychange', function() {
        if (document.visibilityState === 'visible' && QwestClock.synced) {
            QwestClock.sync(2);
        }
    });

})();
