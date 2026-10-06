const DB_NAME = 'lunch-lottery-v1';
const VERSION = 1;

function open() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains('restaurants')) db.createObjectStore('restaurants', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('settings')) db.createObjectStore('settings', { keyPath: 'key' });
      if (!db.objectStoreNames.contains('draws')) db.createObjectStore('draws', { keyPath: 'id' });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function run(store, mode, action) {
  const db = await open();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, mode);
    const request = action(tx.objectStore(store));
    tx.oncomplete = () => { db.close(); resolve(request?.result); };
    tx.onerror = () => { db.close(); reject(tx.error); };
    tx.onabort = () => { db.close(); reject(tx.error); };
  });
}

export const db = {
  restaurants: () => run('restaurants', 'readonly', store => store.getAll()),
  saveRestaurant: item => run('restaurants', 'readwrite', store => store.put(item)),
  deleteRestaurant: id => run('restaurants', 'readwrite', store => store.delete(id)),
  settings: async () => (await run('settings', 'readonly', store => store.get('main')))?.value,
  saveSettings: value => run('settings', 'readwrite', store => store.put({ key: 'main', value })),
  meta: async key => (await run('settings', 'readonly', store => store.get(`meta:${key}`)))?.value,
  saveMeta: (key, value) => run('settings', 'readwrite', store => store.put({ key: `meta:${key}`, value })),
  draws: () => run('draws', 'readonly', store => store.getAll()),
  saveDraw: draw => run('draws', 'readwrite', store => store.put(draw)),
  replaceShared: async snapshot => {
    const connection = await open();
    return new Promise((resolve, reject) => {
      const tx = connection.transaction(['restaurants', 'draws'], 'readwrite');
      const restaurants = tx.objectStore('restaurants');
      const draws = tx.objectStore('draws');
      restaurants.clear();
      draws.clear();
      for (const item of snapshot.restaurants) restaurants.put(item);
      for (const item of snapshot.draws) draws.put(item);
      tx.oncomplete = () => { connection.close(); resolve(); };
      tx.onerror = () => { connection.close(); reject(tx.error); };
      tx.onabort = () => { connection.close(); reject(tx.error); };
    });
  }
};
