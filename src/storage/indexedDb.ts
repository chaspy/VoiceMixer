import { openDB } from 'idb';
import type { DBSchema, IDBPDatabase } from 'idb';
import type { Project } from '../types/project';

interface VoiceMixerDb extends DBSchema {
  projects: {
    key: string;
    value: Project;
  };
}

const DB_NAME = 'voicemixer-db';
const DB_VERSION = 1;

let dbPromise: Promise<IDBPDatabase<VoiceMixerDb>> | null = null;

const getDb = (): Promise<IDBPDatabase<VoiceMixerDb>> => {
  if (!dbPromise) {
    dbPromise = openDB<VoiceMixerDb>(DB_NAME, DB_VERSION, {
      upgrade(db) {
        if (!db.objectStoreNames.contains('projects')) {
          db.createObjectStore('projects', { keyPath: 'id' });
        }
      },
    });
  }
  return dbPromise;
};

export const listProjects = async (): Promise<Project[]> => {
  const db = await getDb();
  const all = await db.getAll('projects');
  return all.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
};

export const saveProject = async (project: Project): Promise<void> => {
  const db = await getDb();
  await db.put('projects', { ...project, updatedAt: new Date().toISOString() });
};

export const deleteProjectById = async (projectId: string): Promise<void> => {
  const db = await getDb();
  await db.delete('projects', projectId);
};
