import type Database from "better-sqlite3";

/** Roda o trabalho inteiro ou nenhum pedaço dele no banco. */
export type EmTransacao = <T>(trabalho: () => Promise<T>) => Promise<T>;

/**
 * Uma transação que atravessa chamadas de serviço. Os serviços gravam com o mesmo
 * cliente, e a transação própria deles vira ponto de salvamento dentro desta.
 *
 * O trabalho de dentro só deve esperar o próprio banco: o cliente é síncrono, e quem
 * esperasse rede ou disco aqui deixaria outra gravação do processo entrar na transação.
 */
export function transacaoDoBanco(db: { $client: Database.Database }): EmTransacao {
  return async (trabalho) => {
    const cliente = db.$client;
    // Já dentro de uma: quem abriu primeiro decide.
    if (cliente.inTransaction) return trabalho();
    cliente.exec("BEGIN IMMEDIATE");
    try {
      const resultado = await trabalho();
      cliente.exec("COMMIT");
      return resultado;
    } catch (erro) {
      if (cliente.inTransaction) cliente.exec("ROLLBACK");
      throw erro;
    }
  };
}
