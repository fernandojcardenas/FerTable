import BaseApp from "@/client/ui/BaseApp";

export default async function BasePage({ params }: { params: Promise<{ baseId: string }> }) {
  const { baseId } = await params;
  return <BaseApp baseId={baseId} />;
}
