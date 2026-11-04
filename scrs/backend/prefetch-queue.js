'use strict';

// Simulate upcoming promotions without touching either live queue. This matches
// the current/next rules, including alternate turns and one-off Play next files.
function upcomingMedia({ queue, personal, mode, isOwner, count = 3 }) {
    const requests = queue.slice(1);
    const mine = personal.slice();
    let turn = mode.mode === 'switch' ? (mode.switchTurn === 'mylist' ? 'requests' : 'mylist') : mode.mode;
    const upcoming = [];
    for (let i = 0; i < count; i++) {
        let item;
        const preferMine = !isOwner(requests[0]) && mine.length
            && (mine[0]._playNext || turn === 'mylist' || !requests.some(item => !isOwner(item)));
        if (preferMine) {
            item = mine.shift();
            if (mode.mylistLoop && !item._playNext) mine.push(item);
            item = { ...item, _source: 'mylist' };
        } else {
            item = requests.shift();
            if (item) item = { ...item, _source: isOwner(item) ? 'mylist' : 'requests' };
        }
        if (!item) break;
        upcoming.push(item);
        if (mode.mode === 'switch') turn = turn === 'mylist' ? 'requests' : 'mylist';
    }
    return upcoming;
}

module.exports = { upcomingMedia };
