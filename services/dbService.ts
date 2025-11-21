import { HistoryItem, Session } from '../types';

const DB_NAME = 'VoicePixelsDB';
const DB_VERSION = 2;
const STORE_NAME = 'history';
const SESSIONS_STORE = 'sessions';

export interface SessionSummary {
  sessionId: string;
  name: string;
  startTime: number;
  itemCount: number;
  previewImage: string;
}

export const initDB = (): Promise<void> => {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onerror = () => reject(request.error);
    request.onsuccess = () => resolve();

    request.onupgradeneeded = (event) => {
      const db = (event.target as IDBOpenDBRequest).result;
      
      // Create history store if it doesn't exist
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        const store = db.createObjectStore(STORE_NAME, { keyPath: 'id' });
        store.createIndex('sessionId', 'sessionId', { unique: false });
        store.createIndex('timestamp', 'timestamp', { unique: false });
      }
      
      // Create sessions store for session metadata
      if (!db.objectStoreNames.contains(SESSIONS_STORE)) {
        const sessionsStore = db.createObjectStore(SESSIONS_STORE, { keyPath: 'sessionId' });
        sessionsStore.createIndex('updatedAt', 'updatedAt', { unique: false });
      }
    };
  });
};

export const saveHistoryItem = async (item: HistoryItem): Promise<void> => {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(STORE_NAME, 'readwrite');
    const store = transaction.objectStore(STORE_NAME);
    const request = store.put(item);

    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  });
};

export const getSessionItems = async (sessionId: string): Promise<HistoryItem[]> => {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(STORE_NAME, 'readonly');
    const store = transaction.objectStore(STORE_NAME);
    const index = store.index('sessionId');
    const request = index.getAll(sessionId);

    request.onsuccess = () => {
      const items = request.result as HistoryItem[];
      // Sort by timestamp
      items.sort((a, b) => a.timestamp - b.timestamp);
      resolve(items);
    };
    request.onerror = () => reject(request.error);
  });
};

export const saveSessionName = async (sessionId: string, name: string): Promise<void> => {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(SESSIONS_STORE, 'readwrite');
    const store = transaction.objectStore(SESSIONS_STORE);
    
    // Try to get existing session
    const getRequest = store.get(sessionId);
    
    getRequest.onsuccess = () => {
      const existing = getRequest.result as Session | undefined;
      const session: Session = {
        sessionId,
        name,
        createdAt: existing?.createdAt || Date.now(),
        updatedAt: Date.now()
      };
      
      const putRequest = store.put(session);
      putRequest.onsuccess = () => resolve();
      putRequest.onerror = () => reject(putRequest.error);
    };
    
    getRequest.onerror = () => reject(getRequest.error);
  });
};

export const getSessionName = async (sessionId: string): Promise<string | null> => {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(SESSIONS_STORE, 'readonly');
    const store = transaction.objectStore(SESSIONS_STORE);
    const request = store.get(sessionId);

    request.onsuccess = () => {
      const session = request.result as Session | undefined;
      resolve(session?.name || null);
    };
    request.onerror = () => reject(request.error);
  });
};

export const deleteSession = async (sessionId: string): Promise<void> => {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction([STORE_NAME, SESSIONS_STORE], 'readwrite');
    const historyStore = transaction.objectStore(STORE_NAME);
    const sessionsStore = transaction.objectStore(SESSIONS_STORE);
    
    // Delete all history items for this session
    const historyIndex = historyStore.index('sessionId');
    const historyRequest = historyIndex.openCursor(IDBKeyRange.only(sessionId));
    
    historyRequest.onsuccess = (event) => {
      const cursor = (event.target as IDBRequest).result;
      if (cursor) {
        cursor.delete();
        cursor.continue();
      }
    };
    
    // Delete the session metadata
    sessionsStore.delete(sessionId);
    
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
  });
};

export const getAllSessions = async (): Promise<SessionSummary[]> => {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction([STORE_NAME, SESSIONS_STORE], 'readonly');
    const historyStore = transaction.objectStore(STORE_NAME);
    const sessionsStore = transaction.objectStore(SESSIONS_STORE);
    
    const historyRequest = historyStore.getAll();

    historyRequest.onsuccess = () => {
      const items = historyRequest.result as HistoryItem[];
      const sessionsMap = new Map<string, HistoryItem[]>();

      items.forEach(item => {
        if (!sessionsMap.has(item.sessionId)) {
          sessionsMap.set(item.sessionId, []);
        }
        sessionsMap.get(item.sessionId)?.push(item);
      });

      // Get all session names
      const sessionsRequest = sessionsStore.getAll();
      
      sessionsRequest.onsuccess = () => {
        const sessionData = sessionsRequest.result as Session[];
        const sessionNamesMap = new Map(sessionData.map(s => [s.sessionId, s.name]));
        
        const summaries: SessionSummary[] = Array.from(sessionsMap.entries()).map(([sessionId, sessionItems]) => {
          // Sort items to get the earliest one for start time
          sessionItems.sort((a, b) => a.timestamp - b.timestamp);
          return {
            sessionId,
            name: sessionNamesMap.get(sessionId) || 'Untitled Session',
            startTime: sessionItems[0].timestamp,
            itemCount: sessionItems.length,
            // Use the last image as preview
            previewImage: sessionItems[sessionItems.length - 1].data
          };
        });

        // Sort sessions by most recent first
        summaries.sort((a, b) => b.startTime - a.startTime);
        resolve(summaries);
      };
      
      sessionsRequest.onerror = () => reject(sessionsRequest.error);
    };
    historyRequest.onerror = () => reject(historyRequest.error);
  });
};

const openDB = (): Promise<IDBDatabase> => {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
};
