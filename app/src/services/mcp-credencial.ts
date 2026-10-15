/**
 * Cabeçalho `Authorization` escrito à mão na configuração do servidor: tem
 * valor, e o valor não é marcador nem variável por resolver. Vazio ou com
 * `${...}` solto não autentica ninguém, e não conta.
 */
export function temCredencialLiteral(headers: Record<string, string> | undefined): boolean {
  return Object.entries(headers ?? {}).some(
    ([chave, valor]) => chave.toLowerCase() === "authorization" && valor.trim() !== "" && !valor.includes("${"),
  );
}
