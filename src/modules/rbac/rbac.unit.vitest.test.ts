import { describe, expect, it } from "vitest";
import {
  ALL_PERMISSION_KEYS,
  HOSPITAL_ROLE_DEFINITIONS,
  PERMISSION_CATALOGUE,
  PLATFORM_ROLE_DEFINITIONS,
} from "./rbac.catalogue.js";
import { isCataloguePermission, listPermissions } from "./rbac.service.js";

describe("RBAC catalogue", () => {
  it("has unique, well-formed permission keys", () => {
    const keys = PERMISSION_CATALOGUE.map((permission) => permission.key);

    expect(new Set(keys).size).toBe(keys.length);
    for (const permission of PERMISSION_CATALOGUE) {
      // Legacy keys are `<module>:<action>`; Task 16.6 scheduling keys add a
      // second segment (`schedule.break.create`, `doctor.leave.approve`).
      expect(permission.key).toMatch(/^[a-z]+(?:[:.][a-z_]+)+$/);
      expect(
        permission.key.startsWith(`${permission.module}:`) ||
          permission.key.startsWith(`${permission.module}.`),
      ).toBe(true);
    }
  });

  it("only references catalogue permissions from seeded roles", () => {
    const known = new Set<string>(ALL_PERMISSION_KEYS);

    for (const role of [...PLATFORM_ROLE_DEFINITIONS, ...HOSPITAL_ROLE_DEFINITIONS]) {
      for (const key of role.permissions) {
        expect(known.has(key), `${role.slug} references ${key}`).toBe(true);
      }
    }
  });

  it("keeps platform-only actions out of hospital roles", () => {
    const platformOnly = ["tenant:create", "tenant:suspend", "tenant:delete"];

    for (const role of HOSPITAL_ROLE_DEFINITIONS) {
      for (const key of platformOnly) {
        expect(role.permissions).not.toContain(key);
      }
    }
  });

  it("defines the doctor permissions and the documented role matrix", () => {
    const doctorKeys = PERMISSION_CATALOGUE.filter(
      (permission) => permission.module === "doctor",
    ).map((permission) => permission.key);

    expect(doctorKeys).toEqual(
      expect.arrayContaining([
        "doctor:read",
        "doctor:create",
        "doctor:update",
        "doctor:delete",
      ]),
    );

    const role = (slug: string) => {
      const definition = HOSPITAL_ROLE_DEFINITIONS.find((item) => item.slug === slug);
      expect(definition, `${slug} is seeded`).toBeDefined();
      return definition!;
    };

    // Full management stays with the hospital administrator.
    expect(role("hospital_admin").permissions).toEqual(
      expect.arrayContaining([
        "doctor:read",
        "doctor:create",
        "doctor:update",
        "doctor:delete",
      ]),
    );

    // Directory reads for clinical and front-desk roles.
    for (const slug of [
      "branch_admin",
      "receptionist",
      "doctor",
      "nurse",
      "pharmacist",
      "lab_technician",
    ]) {
      expect(role(slug).permissions).toContain("doctor:read");
    }

    // No role other than hospital_admin may mutate doctor profiles. This is
    // what keeps the DOCTOR role read-only, including for its own profile.
    for (const definition of HOSPITAL_ROLE_DEFINITIONS) {
      if (definition.slug === "hospital_admin") continue;

      expect(definition.permissions).not.toContain("doctor:create");
      expect(definition.permissions).not.toContain("doctor:update");
      expect(definition.permissions).not.toContain("doctor:delete");
    }

    expect(role("accountant").permissions).not.toContain("doctor:read");
  });

  it("defines the Task 16.6 scheduling permissions and default matrix", () => {
    const schedulingKeys = [
      "schedule.create",
      "schedule.read",
      "schedule.update",
      "schedule.delete",
      "schedule.break.create",
      "schedule.break.read",
      "schedule.break.update",
      "schedule.break.delete",
      "doctor.leave.create",
      "doctor.leave.read",
      "doctor.leave.update",
      "doctor.leave.approve",
      "doctor.leave.reject",
      "doctor.leave.cancel",
    ];

    const catalogueKeys = new Set<string>(ALL_PERMISSION_KEYS);
    for (const key of schedulingKeys) {
      expect(catalogueKeys.has(key), `${key} is catalogued`).toBe(true);
    }

    const role = (slug: string) => {
      const definition = HOSPITAL_ROLE_DEFINITIONS.find((item) => item.slug === slug);
      expect(definition, `${slug} is seeded`).toBeDefined();
      return definition!;
    };

    // Hospital and branch administrators manage the full scheduling module.
    for (const slug of ["hospital_admin", "branch_admin"]) {
      expect(role(slug).permissions).toEqual(expect.arrayContaining(schedulingKeys));
    }

    // The doctor role reads schedules/breaks, manages its own leave, and must
    // never be able to approve or reject leave by default.
    expect(role("doctor").permissions).toEqual(
      expect.arrayContaining([
        "schedule.read",
        "schedule.break.read",
        "doctor.leave.create",
        "doctor.leave.read",
        "doctor.leave.update",
        "doctor.leave.cancel",
      ]),
    );
    expect(role("doctor").permissions).not.toContain("doctor.leave.approve");
    expect(role("doctor").permissions).not.toContain("doctor.leave.reject");
    expect(role("doctor").permissions).not.toContain("schedule.create");
    expect(role("doctor").permissions).not.toContain("schedule.update");

    // Reception is read-only for the roster and leave list.
    expect(role("receptionist").permissions).toEqual(
      expect.arrayContaining([
        "schedule.read",
        "schedule.break.read",
        "doctor.leave.read",
      ]),
    );
    expect(role("receptionist").permissions).not.toContain("schedule.create");
    expect(role("receptionist").permissions).not.toContain("doctor.leave.approve");

    // Nurses read the roster but have no leave decision access.
    expect(role("nurse").permissions).toEqual(
      expect.arrayContaining(["schedule.read", "schedule.break.read"]),
    );
    expect(role("nurse").permissions).not.toContain("doctor.leave.approve");
    expect(role("nurse").permissions).not.toContain("doctor.leave.reject");
  });

  it("grants audit history only to hospital and branch administrators", () => {
    const role = (slug: string) =>
      HOSPITAL_ROLE_DEFINITIONS.find((definition) => definition.slug === slug)!;

    expect(role("hospital_admin").permissions).toContain("audit:read");
    expect(role("branch_admin").permissions).toContain("audit:read");

    for (const definition of HOSPITAL_ROLE_DEFINITIONS) {
      if (["hospital_admin", "branch_admin"].includes(definition.slug)) continue;
      expect(definition.permissions).not.toContain("audit:read");
    }
  });

  it("exposes catalogue lookups used by permission guards", () => {
    expect(isCataloguePermission("patient:read")).toBe(true);
    expect(isCataloguePermission("patient:fly")).toBe(false);

    const catalogue = listPermissions();
    expect(catalogue).toHaveLength(PERMISSION_CATALOGUE.length);
    expect(catalogue[0]).toMatchObject({
      key: "tenant:read",
      module: "tenant",
    });
  });
});
