import React, { useState } from "react";
import "./_group.css";
import { ENTRIES, TYPES, colorForType, labelForType } from "./_data";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ScrollArea, ScrollBar } from "@/components/ui/scroll-area";
import { Plus, Pencil, Trash2, Upload, Download, Settings2, Sparkles, Tag, ChevronRight, MessageCircle, HelpCircle, FileText, Globe, Percent } from "lucide-react";
import { cn } from "@/lib/utils";

const ICONS: Record<string, any> = {
  product: Tag,
  faq: HelpCircle,
  script: FileText,
  testimonial: MessageCircle,
  website: Globe,
  promo: Percent,
};

export default function SectionStack() {
  const [searchQuery, setSearchQuery] = useState("");

  const filteredEntries = ENTRIES.filter(e => 
    e.title.toLowerCase().includes(searchQuery.toLowerCase()) || 
    e.content.toLowerCase().includes(searchQuery.toLowerCase())
  );

  return (
    <div className="min-h-screen w-full bg-background text-foreground flex flex-col font-sans">
      {/* Hero Strip */}
      <div className="bg-primary text-primary-foreground px-8 py-12 flex flex-col items-center justify-center text-center space-y-4 shadow-sm z-10 relative overflow-hidden">
        <div className="absolute inset-0 bg-black/15 pointer-events-none" />
        <div className="absolute inset-0 bg-gradient-to-t from-black/20 to-transparent pointer-events-none" />
        <div className="relative z-10 max-w-3xl w-full flex flex-col items-center gap-4">
          <Badge variant="outline" className="border-primary-foreground/30 text-primary-foreground bg-primary-foreground/10 uppercase tracking-widest text-[10px] font-bold px-3 py-1">Knowledge Base</Badge>
          <h1 className="text-4xl sm:text-5xl font-extrabold tracking-tight">12 entri AI siap dipakai</h1>
          <p className="text-primary-foreground/90 max-w-xl text-sm sm:text-base">Semua data ini akan digunakan oleh Maxichan untuk menjawab pertanyaan customer. Pastikan data selalu up-to-date untuk akurasi maksimal.</p>
          <div className="flex flex-wrap items-center justify-center gap-3 mt-6">
            <Button variant="secondary" className="bg-white text-primary hover:bg-white/90 font-medium px-6">
              <Plus className="w-4 h-4 mr-2" /> Add Entry
            </Button>
            <Button variant="outline" className="border-primary-foreground/20 bg-primary-foreground/10 text-primary-foreground hover:bg-primary-foreground/20 hover:text-white">
              <Settings2 className="w-4 h-4 mr-2" /> Kelola Type
            </Button>
            <Button variant="outline" className="border-primary-foreground/20 bg-primary-foreground/10 text-primary-foreground hover:bg-primary-foreground/20 hover:text-white">
              <Upload className="w-4 h-4 mr-2" /> Import
            </Button>
            <Button variant="outline" className="border-primary-foreground/20 bg-primary-foreground/10 text-primary-foreground hover:bg-primary-foreground/20 hover:text-white">
              <Download className="w-4 h-4 mr-2" /> Export
            </Button>
          </div>
        </div>
      </div>

      {/* Sections */}
      <div className="flex-1 p-8 overflow-y-auto bg-black/20">
        <div className="max-w-[1600px] mx-auto space-y-16 pb-20">
          {TYPES.map(type => {
            const typeEntries = filteredEntries.filter(e => e.type === type.value);
            if (typeEntries.length === 0) return null;
            
            const Icon = ICONS[type.value] || Sparkles;

            return (
              <section key={type.id} className="space-y-6">
                <div className="flex items-end justify-between border-b border-white/5 pb-4">
                  <div className="flex items-center gap-4">
                    <div className={cn("p-2.5 rounded-xl shadow-sm border border-white/5", colorForType(type.value).split(" ")[0])}>
                      <Icon className={cn("w-6 h-6", colorForType(type.value).split(" ")[1])} />
                    </div>
                    <div>
                      <h2 className="text-2xl font-bold flex items-center gap-3">
                        {type.label}
                        <span className="text-xs font-semibold text-muted-foreground bg-secondary/80 px-2.5 py-1 rounded-full">{typeEntries.length} entries</span>
                      </h2>
                    </div>
                  </div>
                  <Button variant="ghost" className="text-muted-foreground hover:text-primary hover:bg-primary/10 font-medium text-sm">
                    <Plus className="w-4 h-4 mr-2" /> Add to {type.label}
                  </Button>
                </div>
                
                <div className="relative -mx-8 px-8">
                  <ScrollArea className="w-full whitespace-nowrap pb-6">
                    <div className="flex w-max space-x-5">
                      {typeEntries.map(entry => (
                        <Card key={entry.id} className="w-[420px] shrink-0 flex flex-col group bg-card/60 backdrop-blur-sm hover:bg-card/90 transition-all duration-300 border-border/40 hover:border-border/80 shadow-sm hover:shadow-md">
                          <CardHeader className="p-6 pb-4">
                            <div className="flex items-start justify-between gap-4">
                              <CardTitle className="text-lg font-semibold whitespace-normal leading-snug line-clamp-2">{entry.title}</CardTitle>
                              <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity shrink-0 -mt-2 -mr-2">
                                <Button variant="ghost" size="icon" className="w-8 h-8 text-muted-foreground hover:text-foreground bg-background/50 hover:bg-background">
                                  <Pencil className="w-4 h-4" />
                                </Button>
                                <Button variant="ghost" size="icon" className="w-8 h-8 text-muted-foreground hover:text-destructive bg-background/50 hover:bg-background">
                                  <Trash2 className="w-4 h-4" />
                                </Button>
                              </div>
                            </div>
                          </CardHeader>
                          <CardContent className="p-6 pt-0 flex-1">
                            <p className="text-sm text-muted-foreground whitespace-normal line-clamp-4 leading-relaxed">
                              {entry.content}
                            </p>
                          </CardContent>
                        </Card>
                      ))}
                    </div>
                    <ScrollBar orientation="horizontal" className="h-2.5" />
                  </ScrollArea>
                </div>
              </section>
            );
          })}
        </div>
      </div>
    </div>
  );
}
