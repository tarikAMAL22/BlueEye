import { drizzle } from "drizzle-orm/mysql2";
import { accessGroups, groupZoneAccess, zones } from "./schema";
import { eq } from "drizzle-orm";
import "dotenv/config";

const db = drizzle(process.env.DATABASE_URL!);

const DEFAULT_GROUPS = [
  { name: "Inconnus",     description: "Personnes non identifiées détectées par le système", color: "#9333EA", isDefault: true  },
  { name: "Staff",        description: "Personnel employé de l'établissement",                color: "#00F5FF", isDefault: false },
  { name: "Sécurité",     description: "Agents de sécurité et gardiens",                      color: "#EF4444", isDefault: false },
  { name: "Visiteurs",    description: "Visiteurs autorisés temporairement",                   color: "#F59E0B", isDefault: false },
  { name: "Maintenance",  description: "Techniciens et équipes de maintenance",                color: "#10B981", isDefault: false },
];

async function seed() {
  console.log("Seeding access groups...");

  for (const group of DEFAULT_GROUPS) {
    const existing = await db.select().from(accessGroups).where(eq(accessGroups.name, group.name)).limit(1);
    if (existing.length > 0) {
      console.log(`  Skip: "${group.name}" already exists`);
      continue;
    }
    await db.insert(accessGroups).values(group);
    console.log(`  Created: "${group.name}"`);
  }

  // Grant Staff, Sécurité, and Maintenance access to all existing zones
  const allZones = await db.select().from(zones);
  if (allZones.length > 0) {
    const grantedGroups = await db.select()
      .from(accessGroups)
      .where(eq(accessGroups.isDefault, false));

    for (const group of grantedGroups) {
      if (!["Staff", "Sécurité", "Maintenance"].includes(group.name)) continue;
      for (const zone of allZones) {
        const existing = await db.select()
          .from(groupZoneAccess)
          .where(eq(groupZoneAccess.groupId, group.id))
          .limit(1);
        if (existing.length === 0) {
          await db.insert(groupZoneAccess).values({ groupId: group.id, zoneId: zone.id });
          console.log(`  Zone access: ${group.name} → Zone #${zone.id} (${zone.name})`);
        }
      }
    }
  }

  console.log("Done.");
  process.exit(0);
}

seed().catch(err => { console.error(err); process.exit(1); });
