// Loads the sample network, tariffs and customers into a development database.
// Idempotent: existing records (matched by id/code/account number) are left unchanged.
import 'dotenv/config';
import { readFile } from 'node:fs/promises';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();
const data = JSON.parse(await readFile(new URL('./seed-data.json', import.meta.url), 'utf8'));
const str = value => String(value);

async function seed() {
  for (const sub of data.substations) {
    await prisma.substation.upsert({
      where: { id: sub.id },
      update: {},
      create: { id: sub.id, code: sub.code, name: sub.name, capacityMVA: str(sub.capacityMVA), voltageInKV: str(sub.voltageInKV), voltageOutKV: str(sub.voltageOutKV) },
    });
  }
  for (const feeder of data.feeders) {
    await prisma.feeder.upsert({
      where: { id: feeder.id },
      update: {},
      create: {
        id: feeder.id, code: feeder.code, name: feeder.name, substationId: feeder.substationId,
        voltageKV: str(feeder.voltageKV), ratedAmps: str(feeder.ratedAmps),
        overcurrentThresholdA: str(feeder.overcurrentThresholdA), minPowerFactorThreshold: str(feeder.minPowerFactorThreshold),
      },
    });
  }
  for (const transformer of data.transformers) {
    await prisma.transformer.upsert({
      where: { id: transformer.id },
      update: {},
      create: { id: transformer.id, code: transformer.code, name: transformer.name, feederId: transformer.feederId, ratedKVA: str(transformer.ratedKVA) },
    });
  }

  for (const tariff of data.tariffs) {
    if (await prisma.tariffSchedule.findUnique({ where: { code: tariff.code } })) continue;
    await prisma.tariffSchedule.create({
      data: {
        id: tariff.id, code: tariff.code, name: tariff.name, description: tariff.description, customerClass: tariff.customerClass,
        ...Object.fromEntries(Object.entries(tariff.rates).map(([key, value]) => [key, str(value)])),
      },
    });
  }

  for (const customer of data.customers) {
    if (await prisma.customer.findUnique({ where: { accountNumber: customer.accountNumber } })) continue;
    const { meter, onboardingDate, contractedDemandKVA, creditLimit, ...fields } = customer;
    await prisma.customer.create({
      data: {
        ...fields,
        contractedDemandKVA: str(contractedDemandKVA),
        creditLimit: str(creditLimit),
        onboardingDate: new Date(`${onboardingDate}T00:00:00.000Z`),
        meter: {
          create: {
            id: meter.id, serialNumber: meter.serialNumber, feederId: meter.feederId, transformerId: meter.transformerId,
            model: meter.model, commStatus: meter.commStatus, maxDemandKVA: str(meter.maxDemandKVA), powerFactor: str(meter.powerFactor),
          },
        },
      },
    });
  }

  console.log(`Millwater PMS sample data ready: ${data.substations.length} substations, ${data.feeders.length} feeders, ${data.transformers.length} transformers, ${data.customers.length} customers and ${data.tariffs.length} tariff schedules.`);
}

try {
  await seed();
} catch (error) {
  console.error('Millwater PMS seed failed:', error);
  process.exitCode = 1;
} finally {
  await prisma.$disconnect();
}
